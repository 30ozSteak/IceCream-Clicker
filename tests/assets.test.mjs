import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("the reviewed portrait manifest is local, complete, and normalized", async () => {
  const manifest = await readFile(new URL("lib/portraits.ts", projectRoot), "utf8");
  const portraitDirectory = new URL("public/portraits/", projectRoot);
  const portraitFiles = (await readdir(portraitDirectory))
    .filter((name) => name.endsWith(".webp"))
    .sort();
  const entries = [...manifest.matchAll(
    /id: "([a-z0-9_]+)",\s+src: "\/portraits\/([a-z0-9_]+\.webp)",\s+alt: "([^"]+)",\s+mouth: \{ cx: ([0-9.]+), cy: ([0-9.]+), rx: ([0-9.]+), ry: ([0-9.]+) \}/g,
  )];

  assert.ok(entries.length >= 50, `expected at least 50 portraits, found ${entries.length}`);
  assert.equal(entries.length, portraitFiles.length);
  assert.deepEqual(
    entries.map((entry) => entry[2]).sort(),
    portraitFiles,
  );

  for (const [, id, filename, alt, ...geometry] of entries) {
    assert.equal(filename, `${id}.webp`);
    assert.ok(alt.trim().length > 0);
    for (const coordinate of geometry.map(Number)) {
      assert.ok(coordinate > 0 && coordinate < 1, `${id} has invalid geometry`);
    }
    const file = await stat(new URL(filename, portraitDirectory));
    assert.ok(file.size > 1_000, `${filename} is unexpectedly small`);
  }

  assert.doesNotMatch(manifest, /https?:\/\//i);
});

test("approved brand assets and provenance are present", async () => {
  const manifest = await readFile(new URL("lib/portraits.ts", projectRoot), "utf8");
  const provenance = await readFile(
    new URL("public/THIRD_PARTY_ASSETS.md", projectRoot),
    "utf8",
  );

  for (const path of [
    "public/brand/fatboy-logo.png",
    "public/brand/fatboy-vanilla-6-pack.webp",
    "public/brand/vanilla-sandwich.webp",
  ]) {
    const file = await stat(new URL(path, projectRoot));
    assert.ok(file.size > 10_000, `${path} is unexpectedly small`);
  }

  assert.match(provenance, /FatBoy Broker Resource Center/);
  const documentedCount = provenance.match(/All (\d+) entries.*visually reviewed/is);
  assert.ok(documentedCount, "portrait review count is documented");
  assert.equal(
    Number(documentedCount[1]),
    (manifest.match(/^    id:/gm) ?? []).length,
  );
  assert.match(provenance, /Open Pravatar usage licence/);
});
