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

test("approved brand assets and exact provenance are present", async () => {
  const manifest = await readFile(new URL("lib/portraits.ts", projectRoot), "utf8");
  const provenance = await readFile(
    new URL("public/THIRD_PARTY_ASSETS.md", projectRoot),
    "utf8",
  );

  for (const path of [
    "public/brand/fatboy-logo.png",
    "public/brand/fatboy-vanilla-6-pack.webp",
    "public/brand/fatboy-vanilla-12-pack.webp",
    "public/brand/fatboy-cookies-cream-6-pack.webp",
    "public/brand/fatboy-caramel-cashew-4-pack.webp",
    "public/brand/fatboy-sugar-cookie-6-pack.webp",
    "public/brand/fatboy-caramel-cookies-cream-4-pack.webp",
    "public/brand/fatboy-cinnamon-churro-4-pack.webp",
    "public/brand/fatboy-chocolate-6-pack.webp",
    "public/brand/fatboy-birthday-cake-pops-4-pack.webp",
    "public/brand/vanilla-sandwich.webp",
    "public/og-3d.png",
    "public/og-v2.png",
  ]) {
    const file = await stat(new URL(path, projectRoot));
    assert.ok(file.size > 10_000, `${path} is unexpectedly small`);
  }

  assert.match(provenance, /FatBoy Broker Resource Center/);
  assert.match(provenance, /Smart & Final/);
  for (const sourceUrl of [
    "https://www.smartandfinal.com/product/fatboy-ice-cream-sandwiches-vanilla-premium-id-00077865001015",
    "https://storage.googleapis.com/images-che-prd-2b77e46.che.prd.v8.commerce.mi9cloud.com/product-images/zoom/dab52390-77dc-48e5-940d-120ddf8144b5.jpeg",
    "https://fatboyicecream.com/fatboy-cookies-n-cream-sandwich/",
    "https://fatboyicecream.com/wp-content/uploads/2023/10/FB-SandwichCookiesNCream-6ct-3dbox-02.png",
    "https://fatboyicecream.com/fatboy-caramel-cashew-cookie-sandwich/",
    "https://fatboyicecream.com/wp-content/uploads/2024/02/FB-CarCash-CookieBox.png",
    "https://fatboyicecream.com/fatboy-sugar-cookie-sandwich/",
    "https://fatboyicecream.com/wp-content/uploads/2023/10/FB-SandwichSugarCookie-6ct-3dbox-05.png",
    "https://fatboyicecream.com/fatboy-caramel-cookies-n-cream-cookie-sandwich/",
    "https://fatboyicecream.com/wp-content/uploads/2024/02/FB-CNC-CookieBox.png",
    "https://fatboyicecream.com/fatboy-cinnamon-churro-caramel-cookie-sandwich/",
    "https://fatboyicecream.com/wp-content/uploads/2024/10/FB-Churro-Sandwich-3D.png",
    "https://fatboyicecream.com/fatboy-chocolate-ice-cream-sandwich/",
    "https://fatboyicecream.com/wp-content/uploads/2026/02/Chocolate-6ct-2025_3DBOX_LEFT.png",
    "https://fatboyicecream.com/fatboy-birthday-cake-sandwich-pop/",
    "https://fatboyicecream.com/wp-content/uploads/2024/10/FB-Birthday-Cake-4ct-3D-1.png",
  ]) {
    assert.ok(provenance.includes(sourceUrl), `${sourceUrl} is not documented`);
  }
  const documentedCount = provenance.match(/All (\d+) entries.*visually reviewed/is);
  assert.ok(documentedCount, "portrait review count is documented");
  assert.equal(
    Number(documentedCount[1]),
    (manifest.match(/^    id:/gm) ?? []).length,
  );
  assert.match(provenance, /Open Pravatar usage licence/);
});

test("the optimized 3D FatBoy model is local and web-sized", async () => {
  const model = await readFile(
    new URL("public/models/fatboy-sandwich.glb", projectRoot),
  );

  assert.equal(model.subarray(0, 4).toString("ascii"), "glTF");
  assert.equal(model.readUInt32LE(4), 2, "expected a glTF 2.0 binary");
  assert.equal(model.readUInt32LE(8), model.length, "GLB length must match");
  assert.ok(model.length > 100_000, "3D model is unexpectedly small");
  assert.ok(model.length < 5_000_000, "3D model is too large for gameplay");
});
