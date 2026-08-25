import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCoverGeometry,
  normalizedImagePointToStage,
} from "../lib/client/portrait-geometry.ts";

function closeTo(actual, expected, epsilon = 0.000_001) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test("portrait cover geometry scales normalized mouths on desktop and mobile", () => {
  const desktop = calculateCoverGeometry(1_000, 600, 800, 1_200);
  assert.deepEqual(desktop, {
    renderedWidth: 1_000,
    renderedHeight: 1_500,
    offsetX: 0,
    offsetY: -450,
  });
  assert.deepEqual(normalizedImagePointToStage(desktop, 0.5, 0.5), {
    x: 500,
    y: 300,
  });

  const mobile = calculateCoverGeometry(330, 379.5, 800, 1_200);
  closeTo(mobile.renderedWidth, 330);
  closeTo(mobile.renderedHeight, 495);
  closeTo(mobile.offsetX, 0);
  closeTo(mobile.offsetY, -57.75);
  const mouth = normalizedImagePointToStage(mobile, 0.46626, 0.4518);
  closeTo(mouth.x, 153.8658);
  closeTo(mouth.y, 165.891);

  // A small face landmark may render below 44px, but the accessible button is
  // intentionally enlarged while submissions use this same server-owned center.
  closeTo(0.045 * 2 * mobile.renderedWidth, 29.7);
});

test("portrait cover geometry handles horizontal cropping and invalid inputs", () => {
  const portrait = calculateCoverGeometry(600, 800, 1_200, 800);
  assert.deepEqual(portrait, {
    renderedWidth: 1_200,
    renderedHeight: 800,
    offsetX: -300,
    offsetY: 0,
  });
  assert.deepEqual(normalizedImagePointToStage(portrait, 0.25, 0.5), {
    x: 0,
    y: 400,
  });
  assert.throws(() => calculateCoverGeometry(0, 800, 1_200, 800), RangeError);
});
