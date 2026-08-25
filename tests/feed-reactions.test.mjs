import assert from "node:assert/strict";
import test from "node:test";
import {
  FEED_REACTIONS,
  getFeedReaction,
} from "../lib/feed-reactions.ts";

test("feed reactions cycle through the requested copy without repeats", () => {
  assert.deepEqual(FEED_REACTIONS, [
    "Wow!",
    "Yum!",
    "Delicious!",
    "Another!",
  ]);

  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) => getFeedReaction(index + 1)),
    [...FEED_REACTIONS, ...FEED_REACTIONS],
  );
});

test("feed reactions fall back safely for invalid counts", () => {
  assert.equal(getFeedReaction(0), "Wow!");
  assert.equal(getFeedReaction(-4), "Wow!");
  assert.equal(getFeedReaction(Number.NaN), "Wow!");
});
