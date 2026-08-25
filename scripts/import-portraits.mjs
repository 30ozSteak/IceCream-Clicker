#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORTRAIT_DIR = path.join(ROOT, "public", "portraits");
const MANIFEST_PATH = path.join(ROOT, "lib", "portraits.ts");
// The API reports 72 portrait assets but caps an individual result set at 60.
// These broad facets deterministically expose the complete portrait cohort; the
// importer de-duplicates stable IDs before applying eligibility checks.
const CATALOG_URLS = [
  "https://openpravatar.com/api/search?family=portrait&limit=100",
  "https://openpravatar.com/api/search?family=portrait&q=woman&limit=100",
  "https://openpravatar.com/api/search?family=portrait&q=man&limit=100",
  "https://openpravatar.com/api/search?family=portrait&q=androgynous&limit=100",
  "https://openpravatar.com/api/search?family=portrait&q=professional&limit=100",
  "https://openpravatar.com/api/search?family=portrait&q=profile&limit=100",
];
const ALLOWED_AGE_BANDS = new Set([
  "young-adult",
  "adult",
  "middle-aged",
  "older-adult",
]);

const swiftDetector = String.raw`
import Foundation
import ImageIO
import Vision

struct Detection: Codable {
    let id: String
    let faceCount: Int
    let cx: Double?
    let cy: Double?
    let rx: Double?
    let ry: Double?
    let reason: String?
}

func clamp(_ value: Double, _ minimum: Double, _ maximum: Double) -> Double {
    return min(max(value, minimum), maximum)
}

var detections: [Detection] = []

for argument in CommandLine.arguments.dropFirst() {
    autoreleasepool {
        let fileURL = URL(fileURLWithPath: argument)
        let id = fileURL.deletingPathExtension().lastPathComponent

        guard
            let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            detections.append(Detection(
                id: id, faceCount: 0, cx: nil, cy: nil, rx: nil, ry: nil,
                reason: "ImageIO could not decode the image"
            ))
            return
        }

        let request = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up)

        do {
            try handler.perform([request])
        } catch {
            detections.append(Detection(
                id: id, faceCount: 0, cx: nil, cy: nil, rx: nil, ry: nil,
                reason: "Vision request failed: \(error.localizedDescription)"
            ))
            return
        }

        let faces = request.results ?? []
        guard faces.count == 1 else {
            detections.append(Detection(
                id: id, faceCount: faces.count, cx: nil, cy: nil, rx: nil,
                ry: nil, reason: "Expected exactly one detectable face"
            ))
            return
        }

        let face = faces[0]
        guard let lips = face.landmarks?.outerLips, !lips.normalizedPoints.isEmpty else {
            detections.append(Detection(
                id: id, faceCount: 1, cx: nil, cy: nil, rx: nil, ry: nil,
                reason: "No outer-lip landmarks"
            ))
            return
        }

        let box = face.boundingBox
        let points = lips.normalizedPoints.map { point -> CGPoint in
            let imageX = box.minX + point.x * box.width
            let visionY = box.minY + point.y * box.height
            return CGPoint(x: imageX, y: 1.0 - visionY)
        }
        let minX = points.map(\.x).min()!
        let maxX = points.map(\.x).max()!
        let minY = points.map(\.y).min()!
        let maxY = points.map(\.y).max()!

        // Expand the lip outline into a forgiving game target. The lower bounds
        // keep the visual/click target practical on smaller screens; upper bounds
        // prevent a weak landmark result from covering most of a face.
        let cx = clamp(Double((minX + maxX) / 2.0), 0.0, 1.0)
        let cy = clamp(Double((minY + maxY) / 2.0), 0.0, 1.0)
        let rx = clamp(Double((maxX - minX) / 2.0 * 1.35), 0.045, 0.085)
        let ry = clamp(Double((maxY - minY) / 2.0 * 2.2), 0.035, 0.065)

        detections.append(Detection(
            id: id, faceCount: 1, cx: cx, cy: cy, rx: rx, ry: ry,
            reason: nil
        ))
    }
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let output = try encoder.encode(detections)
print(String(decoding: output, as: UTF8.self))
`;

function isEligible(asset) {
  return (
    asset?.review_status === "approved" &&
    asset?.subject_count === 1 &&
    asset?.family === "portrait" &&
    asset?.license === "synthetic-commercial" &&
    ALLOWED_AGE_BANDS.has(asset?.age_band) &&
    typeof asset?.id === "string" &&
    /^[a-z0-9_]+$/.test(asset.id) &&
    typeof asset?.title === "string"
  );
}

async function downloadPortrait(asset) {
  const sourceUrl = `https://openpravatar.com/thumbs/${asset.id}.webp?w=800`;
  const response = await fetch(sourceUrl, {
    headers: { "User-Agent": "FatBoy-Feed-Frenzy-asset-import/1.0" },
  });
  if (!response.ok) {
    throw new Error(`${asset.id}: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/webp")) {
    throw new Error(`${asset.id}: expected image/webp, received ${contentType}`);
  }

  const destination = path.join(PORTRAIT_DIR, `${asset.id}.webp`);
  const temporary = `${destination}.download`;
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  await rename(temporary, destination);
  return destination;
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

function detectMouths(imagePaths) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/swift", ["-", ...imagePaths], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Swift detector exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `Could not parse detector output: ${error.message}\n${stderr.trim()}`,
          ),
        );
      }
    });
    child.stdin.end(swiftDetector);
  });
}

function formatNumber(value) {
  return Number(value).toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
}

function buildManifest(assets, detections) {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const entries = detections
    .filter(
      (detection) =>
        assetById.has(detection.id) &&
        [detection.cx, detection.cy, detection.rx, detection.ry].every(
          Number.isFinite,
        ),
    )
    .map((detection) => {
      const asset = assetById.get(detection.id);
      return `  {
    id: ${JSON.stringify(asset.id)},
    src: ${JSON.stringify(`/portraits/${asset.id}.webp`)},
    alt: ${JSON.stringify(asset.title)},
    mouth: { cx: ${formatNumber(detection.cx)}, cy: ${formatNumber(detection.cy)}, rx: ${formatNumber(detection.rx)}, ry: ${formatNumber(detection.ry)} },
  },`;
    });

  return `// Generated by scripts/import-portraits.mjs from approved Open Pravatar assets.
// Mouth coordinates use normalized, top-left-origin image space.

export interface MouthTarget {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

export interface Portrait {
  readonly id: string;
  readonly src: string;
  readonly alt: string;
  readonly mouth: MouthTarget;
}

export const PORTRAITS = [
${entries.join("\n")}
] as const satisfies readonly Portrait[];

export const PORTRAIT_BY_ID: ReadonlyMap<string, Portrait> = new Map(
  PORTRAITS.map((portrait) => [portrait.id, portrait]),
);
`;
}

async function main() {
  await mkdir(PORTRAIT_DIR, { recursive: true });
  await mkdir(path.dirname(MANIFEST_PATH), { recursive: true });

  const catalogs = await Promise.all(
    CATALOG_URLS.map(async (catalogUrl) => {
      const response = await fetch(catalogUrl, {
        headers: { "User-Agent": "FatBoy-Feed-Frenzy-asset-import/1.0" },
      });
      if (!response.ok) {
        throw new Error(
          `Catalog request failed with HTTP ${response.status}: ${catalogUrl}`,
        );
      }
      return response.json();
    }),
  );
  const assetById = new Map();
  for (const catalog of catalogs) {
    for (const asset of catalog.results ?? []) {
      if (isEligible(asset) && !assetById.has(asset.id)) {
        assetById.set(asset.id, asset);
      }
    }
  }
  const assets = [...assetById.values()].slice(0, 100);
  if (assets.length < 50) {
    throw new Error(`Only ${assets.length} eligible portraits; at least 50 required`);
  }

  console.log(`Downloading ${assets.length} approved synthetic portraits...`);
  const imagePaths = await mapWithConcurrency(assets, 6, downloadPortrait);
  console.log("Detecting mouth landmarks with Apple Vision...");
  const detections = await detectMouths(imagePaths);
  const acceptedIds = new Set(
    detections
      .filter((detection) => Number.isFinite(detection.cx))
      .map((detection) => detection.id),
  );
  const acceptedAssets = assets.filter((asset) => acceptedIds.has(asset.id));
  const rejected = detections.filter((detection) => !acceptedIds.has(detection.id));

  if (acceptedAssets.length < 50) {
    throw new Error(
      `Only ${acceptedAssets.length} portraits had usable mouth landmarks; ` +
        `${rejected.length} rejected`,
    );
  }

  await writeFile(MANIFEST_PATH, buildManifest(acceptedAssets, detections));
  console.log(
    `Wrote ${acceptedAssets.length} portraits to ${path.relative(ROOT, MANIFEST_PATH)}.`,
  );
  if (rejected.length > 0) {
    console.warn(
      `Rejected ${rejected.length}: ${rejected.map((item) => `${item.id} (${item.reason})`).join(", ")}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
