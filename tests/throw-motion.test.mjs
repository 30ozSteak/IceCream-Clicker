import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateIdleRotation,
  createThrowControlPoint,
  createThrowSpin,
  IDLE_ROTATION_PERIOD_MS,
  quadraticThrowPoint,
} from "../lib/client/throw-motion.ts";

function sequenceRandom(values) {
  let index = 0;
  return () => values[index++] ?? 0;
}

test("throw spins vary by axis while always rotating around z", () => {
  assert.deepEqual(
    createThrowSpin(sequenceRandom([0.6, 0.2, 0.3, 0.8, 0.9, 0.7])),
    {
      xTurns: -0.65,
      yTurns: 0.65,
      zTurns: 1.3,
    },
  );

  assert.deepEqual(
    createThrowSpin(sequenceRandom([0.2, 0.1, 0.3, 0.2])),
    {
      xTurns: 0,
      yTurns: 0,
      zTurns: -0.65,
    },
  );
});

test("throw trajectory rises into a visible arch before landing", () => {
  const start = { x: 0, y: -268, z: 90 };
  const end = { x: -80, y: 122, z: 0 };
  const control = createThrowControlPoint(start, end, 844);

  assert.equal(control.x, -40);
  assert.deepEqual(quadraticThrowPoint(start, control, end, 0), start);
  assert.deepEqual(quadraticThrowPoint(start, control, end, 1), end);

  const apex = quadraticThrowPoint(start, control, end, 0.75);
  assert.ok(apex.y >= Math.max(start.y, end.y) + 48);
});

test("idle sandwich completes one slow turn around its vertical axis", () => {
  const start = calculateIdleRotation(0);
  const quarterTurn = calculateIdleRotation(IDLE_ROTATION_PERIOD_MS / 4);
  const halfTurn = calculateIdleRotation(IDLE_ROTATION_PERIOD_MS / 2);
  const fullTurn = calculateIdleRotation(IDLE_ROTATION_PERIOD_MS);

  assert.deepEqual(start, { x: -0.18, y: 0.52, z: -0.08 });
  assert.equal(quarterTurn.x, start.x);
  assert.equal(quarterTurn.z, start.z);
  assert.ok(Math.abs(quarterTurn.y - (start.y + Math.PI / 2)) < 1e-12);
  assert.ok(Math.abs(halfTurn.y - (start.y + Math.PI)) < 1e-12);
  assert.deepEqual(fullTurn, start);
});
