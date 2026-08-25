import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTripleSnap,
  evaluatePopLaunch,
  evaluateSpiralHold,
  getReloadVisualWindows,
  hasValidReloadInteractionConfig,
} from "../lib/reload-interactions.ts";
import { PACK_CATALOG, getPackById } from "../lib/packs.ts";

function requirePack(id) {
  const pack = getPackById(id);
  assert.ok(pack, `Expected ${id} in the pack catalog.`);
  return pack;
}

const vanilla = requirePack("vanilla-6");
const churro = requirePack("cinnamon-churro-4");
const chocolate = requirePack("chocolate-6");
const birthdayPops = requirePack("birthday-cake-pops-4");

test("every catalog reload has valid interaction configuration", () => {
  for (const pack of PACK_CATALOG) {
    assert.equal(
      hasValidReloadInteractionConfig(pack.reload),
      true,
      `${pack.id} has invalid reload interaction configuration`,
    );
  }
});

test("reload visual windows expose every mechanic cue in order", () => {
  assert.strictEqual(getReloadVisualWindows(vanilla.reload), vanilla.reload.windows);

  assert.deepEqual(getReloadVisualWindows(churro.reload), [
    churro.reload.pressWindow,
    ...churro.reload.windows,
  ]);
  assert.strictEqual(
    getReloadVisualWindows(chocolate.reload),
    chocolate.reload.beats,
  );
  assert.deepEqual(getReloadVisualWindows(birthdayPops.reload), [
    birthdayPops.reload.launchWindow,
    ...birthdayPops.reload.windows,
  ]);
});

test("spiral hold accepts inclusive press, release, and hold boundaries", () => {
  const reload = churro.reload;
  const releaseWindow = reload.windows[0];

  assert.equal(
    evaluateSpiralHold(reload.pressWindow.startMs, releaseWindow.startMs, reload),
    true,
  );
  assert.equal(
    evaluateSpiralHold(reload.pressWindow.endMs, releaseWindow.startMs, reload),
    true,
  );
  assert.equal(
    evaluateSpiralHold(reload.pressWindow.startMs, releaseWindow.endMs, reload),
    true,
  );
  assert.equal(
    evaluateSpiralHold(reload.pressWindow.endMs, releaseWindow.endMs, reload),
    true,
  );

  assert.equal(
    evaluateSpiralHold(
      reload.pressWindow.startMs - 1,
      releaseWindow.startMs,
      reload,
    ),
    false,
  );
  assert.equal(
    evaluateSpiralHold(
      reload.pressWindow.endMs + 1,
      releaseWindow.startMs + 1,
      reload,
    ),
    false,
  );
  assert.equal(
    evaluateSpiralHold(
      reload.pressWindow.endMs,
      releaseWindow.startMs - 1,
      reload,
    ),
    false,
  );
  assert.equal(
    evaluateSpiralHold(
      reload.pressWindow.startMs,
      releaseWindow.endMs + 1,
      reload,
    ),
    false,
  );

  assert.equal(
    evaluateSpiralHold(reload.pressWindow.startMs, releaseWindow.startMs, {
      ...reload,
      minHoldMs: releaseWindow.startMs - reload.pressWindow.startMs + 1,
    }),
    false,
  );
  assert.equal(
    evaluateSpiralHold(reload.pressWindow.startMs, releaseWindow.startMs, {
      ...reload,
      maxHoldMs: releaseWindow.startMs - reload.pressWindow.startMs - 1,
    }),
    false,
  );
});

test("triple snap requires all three beats in order and only the final beat completes", () => {
  const reload = chocolate.reload;

  const first = advanceTripleSnap(0, reload.beats[0].startMs, reload);
  assert.deepEqual(first, { status: "progress", nextStep: 1 });

  const second = advanceTripleSnap(
    first.nextStep,
    reload.beats[1].endMs,
    reload,
  );
  assert.deepEqual(second, { status: "progress", nextStep: 2 });

  const third = advanceTripleSnap(
    second.nextStep,
    reload.beats[2].startMs,
    reload,
  );
  assert.deepEqual(third, { status: "perfect", nextStep: 3 });

  assert.deepEqual(advanceTripleSnap(0, reload.beats[0].startMs - 1, reload), {
    status: "missed",
    nextStep: 0,
  });
  assert.deepEqual(advanceTripleSnap(0, reload.beats[0].endMs + 1, reload), {
    status: "missed",
    nextStep: 0,
  });
  assert.deepEqual(advanceTripleSnap(0, reload.beats[1].startMs, reload), {
    status: "missed",
    nextStep: 0,
  });
  assert.deepEqual(advanceTripleSnap(1, reload.beats[0].endMs, reload), {
    status: "missed",
    nextStep: 1,
  });
  assert.deepEqual(advanceTripleSnap(3, reload.beats[2].endMs, reload), {
    status: "missed",
    nextStep: 3,
  });
});

test("pop launch enforces inclusive start, release, travel, and duration boundaries", () => {
  const reload = birthdayPops.reload;
  const validAttempt = {
    startElapsedMs: reload.launchWindow.startMs,
    endElapsedMs: reload.windows[0].startMs,
    startY: 100,
    endY: 100 - reload.minTravelPx,
    gestureDurationMs: 0,
  };

  assert.equal(evaluatePopLaunch(validAttempt, reload), true);
  assert.equal(
    evaluatePopLaunch(
      {
        ...validAttempt,
        startElapsedMs: reload.launchWindow.endMs,
        endElapsedMs: reload.windows[0].endMs,
        gestureDurationMs: reload.maxGestureMs,
      },
      reload,
    ),
    true,
  );

  for (const attempt of [
    { ...validAttempt, startElapsedMs: reload.launchWindow.startMs - 1 },
    { ...validAttempt, startElapsedMs: reload.launchWindow.endMs + 1 },
    { ...validAttempt, endElapsedMs: reload.windows[0].startMs - 1 },
    { ...validAttempt, endElapsedMs: reload.windows[0].endMs + 1 },
    { ...validAttempt, endY: validAttempt.startY - reload.minTravelPx + 1 },
    { ...validAttempt, endY: validAttempt.startY + reload.minTravelPx },
    { ...validAttempt, gestureDurationMs: -1 },
    { ...validAttempt, gestureDurationMs: reload.maxGestureMs + 1 },
  ]) {
    assert.equal(evaluatePopLaunch(attempt, reload), false);
  }
});
