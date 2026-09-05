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

test("portrait provenance is documented and no brand art remains", async () => {
  const manifest = await readFile(new URL("lib/portraits.ts", projectRoot), "utf8");
  const provenance = await readFile(
    new URL("public/THIRD_PARTY_ASSETS.md", projectRoot),
    "utf8",
  );

  const documentedCount = provenance.match(/All (\d+) entries.*visually reviewed/is);
  assert.ok(documentedCount, "portrait review count is documented");
  assert.equal(
    Number(documentedCount[1]),
    (manifest.match(/^    id:/gm) ?? []).length,
  );
  assert.match(provenance, /Open Pravatar usage licence/);

  const publicEntries = await readdir(new URL("public/", projectRoot), {
    recursive: true,
  });
  const portraitOrDoc = /^(portraits(\/|$)|THIRD_PARTY_ASSETS\.md$)/;
  const strays = publicEntries.filter((entry) => !portraitOrDoc.test(entry));
  assert.deepEqual(strays, [], "public/ holds only portraits and their provenance");
});
