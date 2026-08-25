import assert from "node:assert/strict";
import test from "node:test";
import {
  FEED_REACTIONS,
  getFeedReaction,
} from "../lib/feed-reactions.ts";

test("feed reactions cycle through a large, screen-friendly pool", () => {
  assert.equal(FEED_REACTIONS.length, 50);
  assert.equal(new Set(FEED_REACTIONS).size, FEED_REACTIONS.length);
  assert.ok(FEED_REACTIONS.every((reaction) => reaction.length <= 18));

  assert.deepEqual(
    Array.from(
      { length: FEED_REACTIONS.length * 2 },
      (_, index) => getFeedReaction(index + 1),
    ),
    [...FEED_REACTIONS, ...FEED_REACTIONS],
  );
});

test("feed reactions fall back safely for invalid counts", () => {
  assert.equal(getFeedReaction(0), "Wow!");
  assert.equal(getFeedReaction(-4), "Wow!");
  assert.equal(getFeedReaction(Number.NaN), "Wow!");
});
