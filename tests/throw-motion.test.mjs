import assert from "node:assert/strict";
import test from "node:test";
import { createThrowSpin } from "../lib/client/throw-motion.ts";

function sequenceRandom(values) {
  let index = 0;
  return () => values[index++] ?? 0;
}

test("throw spins vary by axis while always rotating around z", () => {
  assert.deepEqual(
    createThrowSpin(sequenceRandom([0.6, 0.2, 0.3, 0.8, 0.9, 0.7])),
    {
      xTurns: -1,
      yTurns: 1,
      zTurns: 2,
    },
  );

  assert.deepEqual(
    createThrowSpin(sequenceRandom([0.2, 0.1, 0.3, 0.2])),
    {
      xTurns: 0,
      yTurns: 0,
      zTurns: -1,
    },
  );
});
