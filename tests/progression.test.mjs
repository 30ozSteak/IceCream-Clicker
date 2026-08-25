import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PACK_QUANTITY,
  PACK_CATALOG,
  PACK_CATALOG_VERSION,
  STARTER_PACKS_BEFORE_UNLOCK,
  getClearedPackHistory,
  getDisplayedClearedPackCount,
  getPackById,
  getPackForOrdinal,
  getPacksCleared,
} from "../lib/packs.ts";
import {
  ACTIVE_RELOAD_END_GRACE_MS,
  classifyPackReload,
  nextReloadOpportunityMs,
} from "../lib/server/game-rules.ts";

const EXPECTED_PACKS = [
  {
    id: "vanilla-6",
    quantity: 6,
    mechanic: "precision",
    imageSrc: "/brand/fatboy-vanilla-6-pack.webp",
  },
  {
    id: "vanilla-12",
    quantity: 12,
    mechanic: "countdown",
    imageSrc: "/brand/fatboy-vanilla-12-pack.webp",
  },
  {
    id: "cookies-cream-6",
    quantity: 6,
    mechanic: "chip-hop",
    imageSrc: "/brand/fatboy-cookies-cream-6-pack.webp",
  },
  {
    id: "caramel-cashew-4",
    quantity: 4,
    mechanic: "hands-off",
    imageSrc: "/brand/fatboy-caramel-cashew-4-pack.webp",
  },
  {
    id: "sugar-cookie-6",
    quantity: 6,
    mechanic: "sprinkle-rush",
    imageSrc: "/brand/fatboy-sugar-cookie-6-pack.webp",
  },
  {
    id: "caramel-cookies-cream-4",
    quantity: 4,
    mechanic: "converge",
    imageSrc: "/brand/fatboy-caramel-cookies-cream-4-pack.webp",
  },
];

test("pack catalog keeps the reviewed products, quantities, and mechanics", () => {
  assert.equal(PACK_CATALOG_VERSION, 1);
  assert.equal(STARTER_PACKS_BEFORE_UNLOCK, 3);
  assert.equal(PACK_CATALOG.length, EXPECTED_PACKS.length);
  assert.equal(MAX_PACK_QUANTITY, 12);
  assert.deepEqual(
    PACK_CATALOG.map(({ id, quantity, imageSrc, reload }) => ({
      id,
      quantity,
      mechanic: reload.id,
      imageSrc,
    })),
    EXPECTED_PACKS,
  );

  assert.equal(
    new Set(PACK_CATALOG.map((pack) => pack.id)).size,
    PACK_CATALOG.length,
  );
  assert.equal(
    new Set(PACK_CATALOG.map((pack) => pack.reload.id)).size,
    PACK_CATALOG.length,
  );
  assert.equal(
    new Set(PACK_CATALOG.map((pack) => pack.imageSrc)).size,
    PACK_CATALOG.length,
  );

  for (const pack of PACK_CATALOG) {
    assert.equal(getPackById(pack.id), pack);
    assert.ok(pack.name.length > 0);
    assert.ok(pack.shortName.length > 0);
    assert.match(pack.accent, /^#[0-9a-f]{6}$/iu);
    assert.match(pack.accentSoft, /^#[0-9a-f]{6}$/iu);
    assert.ok(Number.isSafeInteger(pack.reload.durationMs));
    assert.ok(pack.reload.durationMs > 0);
    assert.ok(pack.reload.label.length > 0);
    assert.ok(pack.reload.instruction.length > 0);

    let previousGraceEndMs = -1;
    for (const window of pack.reload.windows) {
      assert.ok(Number.isSafeInteger(window.startMs));
      assert.ok(Number.isSafeInteger(window.endMs));
      assert.ok(window.startMs >= 0);
      assert.ok(window.startMs < window.endMs);
      assert.ok(window.endMs + ACTIVE_RELOAD_END_GRACE_MS < pack.reload.durationMs);
      assert.ok(
        window.startMs > previousGraceEndMs,
        `${pack.id} reload windows must not overlap, including grace`,
      );
      previousGraceEndMs = window.endMs + ACTIVE_RELOAD_END_GRACE_MS;
    }
  }

  assert.equal(getPackById("not-a-pack"), null);
});

test("pack selector unlocks after three starter boxes and repeats the full tail", () => {
  assert.deepEqual(
    Array.from({ length: 16 }, (_, index) => getPackForOrdinal(index + 1).id),
    [
      "vanilla-6",
      "vanilla-6",
      "vanilla-6",
      "vanilla-12",
      "cookies-cream-6",
      "caramel-cashew-4",
      "sugar-cookie-6",
      "caramel-cookies-cream-4",
      "vanilla-6",
      "vanilla-12",
      "cookies-cream-6",
      "caramel-cashew-4",
      "sugar-cookie-6",
      "caramel-cookies-cream-4",
      "vanilla-6",
      "vanilla-12",
    ],
  );

  for (const invalidOrdinal of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => getPackForOrdinal(invalidOrdinal),
      /positive integer/u,
    );
  }

  assert.equal(getPacksCleared(1, 6), 0);
  assert.equal(getPacksCleared(1, 0), 1);
  assert.equal(getPacksCleared(4, 12), 3);
  assert.equal(getPacksCleared(4, 0), 4);
  assert.equal(getPacksCleared(0, 6), 0);

  assert.deepEqual(
    getClearedPackHistory(10).map((pack) => pack.id),
    [
      "vanilla-6",
      "vanilla-6",
      "vanilla-6",
      "vanilla-12",
      "cookies-cream-6",
      "caramel-cashew-4",
      "sugar-cookie-6",
      "caramel-cookies-cream-4",
      "vanilla-6",
      "vanilla-12",
    ],
  );
  assert.deepEqual(getClearedPackHistory(0), []);
  assert.equal(getDisplayedClearedPackCount(1, 0), 0);
  assert.equal(getDisplayedClearedPackCount(1, 6), 1);
  assert.equal(getDisplayedClearedPackCount(2, 0), 1);
  assert.equal(getDisplayedClearedPackCount(2, 12), 2);
  for (const invalidCount of [-1, 1.5, Number.NaN]) {
    assert.throws(
      () => getClearedPackHistory(invalidCount),
      /nonnegative integer/u,
    );
  }
});

test("every pack reload mechanic classifies all timing boundaries", async (t) => {
  for (const pack of PACK_CATALOG) {
    await t.test(pack.id, () => {
      assert.equal(classifyPackReload(-1, pack), "waiting");
      assert.equal(classifyPackReload(0, pack), "waiting");
      assert.equal(
        nextReloadOpportunityMs(0, pack),
        pack.reload.windows[0]?.startMs ?? pack.reload.durationMs,
      );

      for (const [windowIndex, window] of pack.reload.windows.entries()) {
        assert.equal(classifyPackReload(window.startMs - 1, pack), "waiting");
        assert.equal(classifyPackReload(window.startMs, pack), "perfect");
        assert.equal(classifyPackReload(window.endMs, pack), "perfect");
        assert.equal(
          classifyPackReload(window.endMs + ACTIVE_RELOAD_END_GRACE_MS, pack),
          "perfect",
        );
        assert.equal(
          classifyPackReload(
            window.endMs + ACTIVE_RELOAD_END_GRACE_MS + 1,
            pack,
          ),
          "waiting",
        );

        const nextWindow = pack.reload.windows[windowIndex + 1];
        assert.equal(
          nextReloadOpportunityMs(window.startMs - 1, pack),
          window.startMs,
        );
        assert.equal(
          nextReloadOpportunityMs(window.startMs, pack),
          nextWindow?.startMs ?? pack.reload.durationMs,
        );
      }

      assert.equal(
        classifyPackReload(pack.reload.durationMs - 1, pack),
        "waiting",
      );
      assert.equal(classifyPackReload(pack.reload.durationMs, pack), "standard");
      assert.equal(
        classifyPackReload(pack.reload.durationMs + 1, pack),
        "standard",
      );
      assert.equal(
        nextReloadOpportunityMs(pack.reload.durationMs, pack),
        pack.reload.durationMs,
      );
    });
  }

  assert.throws(() => classifyPackReload(Number.NaN, PACK_CATALOG[0]), /finite/u);
});
