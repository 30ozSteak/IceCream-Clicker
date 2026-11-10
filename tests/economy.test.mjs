import assert from "node:assert/strict";
import test from "node:test";
import {
  BIG_EATER_APPETITE_MULTIPLIER,
  FEEDERS,
  MAX_TAPS_PER_SECOND,
  MILESTONES,
  OFFLINE_CAP_MS,
  PRESTIGE_THRESHOLD,
  appetiteFor,
  applyOfflineEarnings,
  buyFeeder,
  buyTapUpgrade,
  claimDaily,
  createProgress,
  customerBonus,
  feed,
  feederCost,
  idleRate,
  isBigEater,
  isProgress,
  maxPlausibleEarnings,
  offlineEarnings,
  prestige,
  prestigeSprinkles,
  resetCustomer,
  tapPower,
  tapUpgradeCost,
  tapValue,
  totalSpent,
  validateSync,
  UNLOCKS,
  BONUS_EVENTS,
  bonusPayout,
  buyUnlock,
  hasUnlock,
  nextUnlock,
  productionPerSecond,
  rollMystery,
  upgradeProgress,
} from "../lib/economy.ts";
import { formatAmount, formatRate } from "../lib/number-format.ts";

function rich(scoops) {
  return { ...createProgress(scoops), scoops, runFed: scoops };
}

test("a new player taps for one and has no idle income", () => {
  const p = createProgress();
  assert.equal(tapValue(p), 1);
  assert.equal(idleRate(p), 0);
  assert.equal(p.feeders.length, FEEDERS.length);
  assert.ok(isProgress(p));
});

test("costs grow with every purchase and totalSpent adds them up", () => {
  assert.equal(tapUpgradeCost(0), 10);
  assert.ok(tapUpgradeCost(5) > tapUpgradeCost(4));
  assert.equal(feederCost(0, 0), 15);
  assert.equal(feederCost(0, 1), Math.ceil(15 * 1.15));

  let p = rich(1_000);
  p = buyTapUpgrade(p);
  p = buyFeeder(p, 0);
  p = buyFeeder(p, 0);
  assert.equal(totalSpent(p), 10 + 15 + feederCost(0, 1));
  assert.equal(p.scoops, 1_000 - totalSpent(p));
  assert.equal(idleRate(p), 2);
});

test("purchases fail without enough scoops or with a bad index", () => {
  assert.equal(buyTapUpgrade(createProgress()), null);
  assert.equal(buyFeeder(rich(14), 0), null);
  assert.equal(buyFeeder(rich(1e9), FEEDERS.length), null);
  assert.equal(buyFeeder(rich(1e9), -1), null);
});

test("tap power doubles every ten levels and taps share idle income", () => {
  assert.equal(tapPower(0), 1);
  assert.equal(tapPower(9), 10);
  assert.equal(tapPower(10), 22);
  const p = buyFeeder(rich(1e6), 3);
  assert.equal(tapValue(p), 1 + 0.05 * 120);
});

test("feeding fills the customer, pays a bonus, and moves to the next", () => {
  let p = createProgress();
  assert.equal(appetiteFor(1), 10);
  for (let tap = 0; tap < 9; tap += 1) {
    const result = feed(p, 1);
    assert.equal(result.served, null);
    p = result.progress;
  }
  assert.equal(p.customerProgress, 9);

  const result = feed(p, 1);
  assert.deepEqual(result.served, { customer: 1, bonus: 5, bigEater: false });
  assert.equal(result.progress.customer, 2);
  assert.equal(result.progress.customerProgress, 0);
  assert.equal(result.progress.scoops, 15);
  assert.equal(result.progress.lifetimeFed, 15);
  assert.equal(result.progress.runFed, 15);
});

test("one feed serves at most one customer and ignores empty amounts", () => {
  const result = feed(createProgress(), 1e6);
  assert.equal(result.progress.customer, 2);
  const untouched = createProgress();
  assert.equal(feed(untouched, 0).progress, untouched);
  assert.equal(feed(untouched, Number.NaN).progress, untouched);
});

test("every tenth customer is a big eater that can be retried", () => {
  assert.ok(isBigEater(10));
  assert.ok(!isBigEater(11));
  const ordinary = Math.ceil(10 * 1.25 ** 9);
  assert.equal(appetiteFor(10), ordinary * BIG_EATER_APPETITE_MULTIPLIER);
  assert.ok(appetiteFor(11) < appetiteFor(10));
  assert.equal(customerBonus(10), Math.ceil(appetiteFor(10) * 0.3));

  const midway = { ...createProgress(), customer: 10, customerProgress: 40, scoops: 7 };
  const retried = resetCustomer(midway);
  assert.equal(retried.customerProgress, 0);
  assert.equal(retried.customer, 10);
  assert.equal(retried.scoops, 7);
});

test("milestones pay once when lifetime feeding crosses them", () => {
  const before = { ...createProgress(), lifetimeFed: 99, customer: 30 };
  const result = feed(before, 1);
  assert.deepEqual(result.milestones, [{ goal: 100, reward: 10 }]);
  assert.equal(result.progress.milestonesClaimed, 1);
  assert.equal(feed(result.progress, 1).milestones.length, 0);
  assert.equal(createProgress(1_500).milestonesClaimed, 2);
});

test("prestige needs a million fed and keeps only permanent progress", () => {
  assert.equal(prestigeSprinkles(PRESTIGE_THRESHOLD - 1), 0);
  assert.equal(prestigeSprinkles(PRESTIGE_THRESHOLD), 5);
  assert.equal(prestigeSprinkles(4 * PRESTIGE_THRESHOLD), 10);
  assert.equal(prestige(createProgress()), null);

  let p = rich(2e6);
  p = buyFeeder(p, 0);
  p = { ...p, customer: 44, dailyStreak: 3, lastDailyDay: 20_000 };
  const launched = prestige(p);
  assert.equal(launched.sprinkles, 7);
  assert.equal(launched.flavorIndex, 1);
  assert.equal(launched.lifetimeFed, 2e6);
  assert.equal(launched.scoops, 0);
  assert.equal(launched.runFed, 0);
  assert.equal(launched.customer, 1);
  assert.equal(idleRate(launched), 0);
  assert.equal(launched.dailyStreak, 3);
  assert.ok(Math.abs(tapValue(launched) - 1.7) < 1e-9);
});

test("offline earnings are half rate and stop at the cap", () => {
  const p = buyFeeder(rich(1_000), 1);
  assert.equal(offlineEarnings(p, 60_000), 5 * 60 * 0.5);
  assert.equal(
    offlineEarnings(p, OFFLINE_CAP_MS * 10),
    offlineEarnings(p, OFFLINE_CAP_MS),
  );
  assert.equal(offlineEarnings(p, -5), 0);
  assert.equal(offlineEarnings(createProgress(), 60_000), 0);

  const banked = applyOfflineEarnings(p, 60_000);
  assert.equal(banked.scoops, p.scoops + 150);
  assert.equal(banked.customerProgress, p.customerProgress);
});

test("the daily reward is once per UTC day and the streak escalates", () => {
  const day = 86_400_000;
  const first = claimDaily(createProgress(), 100 * day + 5);
  assert.equal(first.streakDay, 1);
  assert.equal(first.reward, 100);
  assert.equal(claimDaily(first.progress, 100 * day + 9_000), null);

  const second = claimDaily(first.progress, 101 * day);
  assert.equal(second.streakDay, 2);
  assert.equal(second.reward, 200);

  const lapsed = claimDaily(second.progress, 104 * day);
  assert.equal(lapsed.streakDay, 1);
});

test("honest play at the tap cap passes sync validation", () => {
  let p = createProgress();
  const start = p;
  const seconds = 5;
  for (let tap = 0; tap < MAX_TAPS_PER_SECOND * seconds; tap += 1) {
    p = feed(p, tapValue(p)).progress;
    p = buyTapUpgrade(p) ?? p;
    p = buyFeeder(p, 0) ?? p;
  }
  assert.ok(p.customer > 1);
  const verdict = validateSync(start, p, seconds * 1_000);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.earned, p.lifetimeFed);
});

test("sync validation rejects invented scoops, free upgrades, and skipped customers", () => {
  const prev = createProgress();
  const cap = maxPlausibleEarnings(prev, prev, 5_000);
  const reject = (next, reason) =>
    assert.deepEqual(validateSync(prev, next, 5_000), { ok: false, reason });

  reject({ ...prev, scoops: 50 }, "unpaid-purchase");
  reject({ ...prev, tapLevel: 3 }, "unpaid-purchase");
  reject(
    { ...prev, scoops: cap * 2, lifetimeFed: cap * 2, runFed: cap * 2 },
    "earned-too-much",
  );
  reject({ ...prev, lifetimeFed: 20, runFed: 5, scoops: 5 }, "earned-too-much");
  reject({ ...prev, customer: 60 }, "customers-too-fast");
  reject({ ...prev, customerProgress: 10 }, "customers-too-fast");
  reject({ ...prev, sprinkles: 99 }, "locked-field-changed");
  reject({ ...prev, lastDailyDay: 5 }, "locked-field-changed");
  reject({ ...prev, milestonesClaimed: 1 }, "milestone-not-reached");
  reject({ ...prev, scoops: -1 }, "malformed");
  reject({ ...prev, feeders: [1] }, "malformed");
  reject(null, "malformed");

  const later = { ...rich(500), tapLevel: 2, customer: 4 };
  assert.deepEqual(validateSync(later, { ...later, tapLevel: 1 }, 5_000), {
    ok: false,
    reason: "went-backwards",
  });
  assert.deepEqual(validateSync(later, { ...later, customer: 3 }, 5_000), {
    ok: false,
    reason: "went-backwards",
  });
});

test("the earnings cap scales with server time, not client claims", () => {
  const p = createProgress();
  const at = (ms) => maxPlausibleEarnings(p, p, ms);
  // A fixed burst allowance plus a part that grows steadily with server time.
  assert.ok(at(60_000) > at(1_000) * 3);
  assert.ok(Math.abs(at(120_000) - at(60_000) - (at(60_000) - at(0))) < 1e-6);
  assert.equal(maxPlausibleEarnings(p, p, -9_999), maxPlausibleEarnings(p, p, 0));
  assert.equal(MILESTONES[0], 100);
});

test("amounts format with truncating suffixes", () => {
  assert.equal(formatAmount(0), "0");
  assert.equal(formatAmount(999.9), "999");
  assert.equal(formatAmount(1_000), "1K");
  assert.equal(formatAmount(1_234), "1.23K");
  assert.equal(formatAmount(1_999), "1.99K");
  assert.equal(formatAmount(45_600_000), "45.6M");
  assert.equal(formatAmount(999_999), "999K");
  assert.equal(formatAmount(2.5e12), "2.5T");
  assert.equal(formatAmount(Number.NaN), "0");
  assert.equal(formatRate(0.25), "0.2");
  assert.equal(formatRate(5), "5");
  assert.equal(formatRate(1_500), "1.5K");
});

test("unlocks are bought once each, in order, and count as spending", () => {
  let p = rich(10_000_000);
  assert.equal(nextUnlock(p).id, "brain-freeze");
  assert.equal(hasUnlock(p, 0), false);
  p = buyUnlock(p);
  assert.equal(hasUnlock(p, 0), true);
  assert.equal(nextUnlock(p).id, "golden-sandwich");
  for (let index = 1; index < UNLOCKS.length; index += 1) {
    p = buyUnlock(p);
  }
  assert.equal(p.unlocks, UNLOCKS.length);
  assert.equal(nextUnlock(p), null);
  assert.equal(buyUnlock(p), null);
  const allCosts = UNLOCKS.reduce((total, unlock) => total + unlock.cost, 0);
  assert.equal(totalSpent(p), allCosts);
  assert.equal(p.scoops, 10_000_000 - allCosts);
  assert.equal(buyUnlock(rich(UNLOCKS[0].cost - 1)), null);
});

test("unlocks survive a flavor launch", () => {
  const p = { ...rich(2e6), unlocks: 3 };
  assert.equal(prestige(p).unlocks, 3);
});

test("saves from before unlocks existed still load", () => {
  const { unlocks, ...old } = createProgress(500);
  assert.equal(unlocks, 0);
  assert.equal(isProgress(old), false);
  const upgraded = upgradeProgress(old);
  assert.equal(upgraded.unlocks, 0);
  assert.equal(upgraded.lifetimeFed, 500);
  assert.equal(upgradeProgress({ ...old, unlocks: 99 }), null);
  assert.equal(upgradeProgress("nope"), null);
});

test("bonus payouts are measured in seconds of production", () => {
  const p = createProgress();
  assert.equal(productionPerSecond(p), 5);
  assert.equal(bonusPayout(p, "sprinkle"), 10);
  assert.equal(bonusPayout(p, "drone"), 300);
  assert.equal(bonusPayout(p, "golden"), 0);
  const busy = buyFeeder(rich(1e6), 3);
  assert.equal(productionPerSecond(busy), idleRate(busy) + 5 * tapValue(busy));
});

test("mystery cone outcomes cover rush, freeze, and feast", () => {
  assert.equal(rollMystery(() => 0.1), "rush");
  assert.equal(rollMystery(() => 0.5), "freeze");
  assert.equal(rollMystery(() => 0.9), "feast");
});

test("catching every bonus in one short sync window still passes", () => {
  let p = { ...rich(0), unlocks: UNLOCKS.length };
  const start = p;
  for (const kind of ["sprinkle", "drone", "mystery"]) {
    for (let index = 0; index < BONUS_EVENTS[kind].count; index += 1) {
      p = feed(p, bonusPayout(p, kind)).progress;
    }
  }
  assert.equal(validateSync(start, p, 1_000).ok, true);
});

test("unlocks cannot be claimed without paying or taken back", () => {
  const prev = rich(0);
  assert.deepEqual(validateSync(prev, { ...prev, unlocks: 1 }, 5_000), {
    ok: false,
    reason: "unpaid-purchase",
  });
  const owned = { ...rich(0), unlocks: 2 };
  assert.deepEqual(validateSync(owned, { ...owned, unlocks: 1 }, 5_000), {
    ok: false,
    reason: "went-backwards",
  });
});
