// Shared game economy. Pure functions only: the browser simulates with them
// and the server uses the same numbers to bound what a sync may claim.
// Every balance value lives in this file.

export interface FeederDefinition {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly baseCost: number;
  /** Treats fed per second by one unit, before multipliers. */
  readonly rate: number;
}

export const FEEDERS: readonly FeederDefinition[] = [
  { id: "spoon-buddy", name: "Spoon Buddy", icon: "🥄", baseCost: 15, rate: 1 },
  { id: "scoop-cart", name: "Scoop Cart", icon: "🛒", baseCost: 100, rate: 5 },
  { id: "soft-serve", name: "Soft-Serve Machine", icon: "🍦", baseCost: 1_100, rate: 25 },
  { id: "truck", name: "Ice Cream Truck", icon: "🚚", baseCost: 12_000, rate: 120 },
  { id: "parlor", name: "Parlor", icon: "🏪", baseCost: 130_000, rate: 650 },
  { id: "factory", name: "Factory", icon: "🏭", baseCost: 1_400_000, rate: 4_000 },
];

export interface FlavorDefinition {
  readonly name: string;
  readonly accent: string;
  readonly accentSoft: string;
}

export const FLAVORS: readonly FlavorDefinition[] = [
  { name: "Premium Vanilla", accent: "#ffd95e", accentSoft: "#fff1b4" },
  { name: "Cookies ’n Cream", accent: "#9fc9e8", accentSoft: "#dcedfa" },
  { name: "Caramel Cashew", accent: "#ff9f4f", accentSoft: "#ffd5ae" },
  { name: "Strawberry Sprinkle", accent: "#ff8fb1", accentSoft: "#ffd6e2" },
  { name: "Mint Chip", accent: "#8fe3b0", accentSoft: "#d6f7e3" },
  { name: "Double Chocolate", accent: "#c98a5b", accentSoft: "#ecd3bf" },
];

export const FEEDER_COST_GROWTH = 1.15;
export const TAP_UPGRADE_BASE_COST = 10;
export const TAP_UPGRADE_COST_GROWTH = 1.35;
/** Each tap also feeds this share of the per-second idle rate. */
export const TAP_IDLE_SHARE = 0.05;

export const APPETITE_BASE = 10;
export const APPETITE_GROWTH = 1.25;
export const BIG_EATER_EVERY = 10;
export const BIG_EATER_APPETITE_MULTIPLIER = 10;
export const BIG_EATER_TIME_MS = 30_000;
export const CUSTOMER_BONUS_SHARE = 0.5;
export const BIG_EATER_BONUS_SHARE = 0.3;

export const FRENZY_MULTIPLIER = 2;
export const FRENZY_DURATION_MS = 10_000;
export const SUGAR_RUSH_MULTIPLIER = 7;
export const SUGAR_RUSH_DURATION_MS = 30_000;

export const PRESTIGE_THRESHOLD = 1_000_000;
export const SPRINKLE_BONUS = 0.1;

export const OFFLINE_CAP_MS = 2 * 60 * 60 * 1_000;
export const OFFLINE_EFFICIENCY = 0.5;

export const MILESTONES: readonly number[] = Array.from(
  { length: 14 },
  (_, index) => 100 * 10 ** index,
);
export const MILESTONE_REWARD_SHARE = 0.1;
export const DAILY_STREAK_LENGTH = 7;

export const MAX_TAPS_PER_SECOND = 20;
/** Customer bonuses add at most this factor on top of what was fed. */
const BONUS_HEADROOM = 1 + CUSTOMER_BONUS_SHARE;
const SYNC_GRACE_MS = 2_000;
/** Keeps every stored number an exact double and the leaderboard a safe integer. */
export const MAX_AMOUNT = 9e15;

export interface Progress {
  /** Spendable currency. */
  scoops: number;
  /** Everything ever earned. This is the leaderboard score. */
  lifetimeFed: number;
  /** Earned since the last flavor launch. */
  runFed: number;
  tapLevel: number;
  /** Units owned per entry in FEEDERS. */
  feeders: number[];
  /** 1-based number of the customer at the counter. */
  customer: number;
  customerProgress: number;
  sprinkles: number;
  flavorIndex: number;
  milestonesClaimed: number;
  dailyStreak: number;
  /** UTC day number of the last daily claim; 0 means never. */
  lastDailyDay: number;
}

export function createProgress(lifetimeFed = 0): Progress {
  return {
    scoops: 0,
    lifetimeFed,
    runFed: 0,
    tapLevel: 0,
    feeders: FEEDERS.map(() => 0),
    customer: 1,
    customerProgress: 0,
    sprinkles: 0,
    flavorIndex: 0,
    milestonesClaimed: MILESTONES.filter((goal) => lifetimeFed >= goal).length,
    dailyStreak: 0,
    lastDailyDay: 0,
  };
}

function isCount(value: unknown, max = 1_000_000): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

function isAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_AMOUNT
  );
}

/** Structural check for progress read from storage or a request body. */
export function isProgress(value: unknown): value is Progress {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    isAmount(p.scoops) &&
    isAmount(p.lifetimeFed) &&
    isAmount(p.runFed) &&
    isAmount(p.customerProgress) &&
    isCount(p.tapLevel, 10_000) &&
    Array.isArray(p.feeders) &&
    p.feeders.length === FEEDERS.length &&
    p.feeders.every((count) => isCount(count, 10_000)) &&
    isCount(p.customer) &&
    p.customer >= 1 &&
    isCount(p.sprinkles) &&
    isCount(p.flavorIndex) &&
    isCount(p.milestonesClaimed, MILESTONES.length) &&
    isCount(p.dailyStreak) &&
    isCount(p.lastDailyDay)
  );
}

export function flavorMultiplier(p: Progress): number {
  return 1 + SPRINKLE_BONUS * p.sprinkles;
}

export function currentFlavor(p: Progress): FlavorDefinition {
  return FLAVORS[p.flavorIndex % FLAVORS.length];
}

export function idleRate(p: Progress): number {
  let rate = 0;
  for (let index = 0; index < FEEDERS.length; index += 1) {
    rate += p.feeders[index] * FEEDERS[index].rate;
  }
  return rate * flavorMultiplier(p);
}

/** Base tap power: +1 per level, doubling every ten levels. */
export function tapPower(level: number): number {
  return (1 + level) * 2 ** Math.floor(level / 10);
}

export function tapValue(p: Progress): number {
  return tapPower(p.tapLevel) * flavorMultiplier(p) + TAP_IDLE_SHARE * idleRate(p);
}

export function tapUpgradeCost(level: number): number {
  return Math.ceil(TAP_UPGRADE_BASE_COST * TAP_UPGRADE_COST_GROWTH ** level);
}

export function feederCost(index: number, owned: number): number {
  return Math.ceil(FEEDERS[index].baseCost * FEEDER_COST_GROWTH ** owned);
}

/** Total scoops needed to own everything in `p` from scratch. */
export function totalSpent(p: Progress): number {
  let spent = 0;
  for (let level = 0; level < p.tapLevel; level += 1) {
    spent += tapUpgradeCost(level);
  }
  for (let index = 0; index < FEEDERS.length; index += 1) {
    for (let owned = 0; owned < p.feeders[index]; owned += 1) {
      spent += feederCost(index, owned);
    }
  }
  return spent;
}

export function isBigEater(customer: number): boolean {
  return customer % BIG_EATER_EVERY === 0;
}

export function appetiteFor(customer: number): number {
  const base = Math.ceil(APPETITE_BASE * APPETITE_GROWTH ** (customer - 1));
  return isBigEater(customer) ? base * BIG_EATER_APPETITE_MULTIPLIER : base;
}

export function customerBonus(customer: number): number {
  const share = isBigEater(customer) ? BIG_EATER_BONUS_SHARE : CUSTOMER_BONUS_SHARE;
  return Math.ceil(appetiteFor(customer) * share);
}

function earn(p: Progress, amount: number): Progress {
  return {
    ...p,
    scoops: Math.min(MAX_AMOUNT, p.scoops + amount),
    lifetimeFed: Math.min(MAX_AMOUNT, p.lifetimeFed + amount),
    runFed: Math.min(MAX_AMOUNT, p.runFed + amount),
  };
}

export interface FeedResult {
  progress: Progress;
  /** Set when this feed filled the customer. */
  served: { customer: number; bonus: number; bigEater: boolean } | null;
  /** Milestone rewards paid by this feed. */
  milestones: { goal: number; reward: number }[];
}

function claimMilestones(p: Progress): Pick<FeedResult, "progress" | "milestones"> {
  let progress = p;
  const milestones: FeedResult["milestones"] = [];
  while (
    progress.milestonesClaimed < MILESTONES.length &&
    progress.lifetimeFed >= MILESTONES[progress.milestonesClaimed]
  ) {
    const goal = MILESTONES[progress.milestonesClaimed];
    const reward = goal * MILESTONE_REWARD_SHARE;
    progress = {
      ...earn(progress, reward),
      milestonesClaimed: progress.milestonesClaimed + 1,
    };
    milestones.push({ goal, reward });
  }
  return { progress, milestones };
}

/**
 * Feeds `amount` treats to the current customer. At most one customer is
 * served per call so each one is seen leaving.
 */
export function feed(p: Progress, amount: number): FeedResult {
  if (!(amount > 0)) {
    return { progress: p, served: null, milestones: [] };
  }

  let progress = earn(p, amount);
  let served: FeedResult["served"] = null;
  const appetite = appetiteFor(p.customer);
  const filled = p.customerProgress + amount;

  if (filled >= appetite) {
    const bonus = customerBonus(p.customer);
    served = { customer: p.customer, bonus, bigEater: isBigEater(p.customer) };
    progress = {
      ...earn(progress, bonus),
      customer: p.customer + 1,
      customerProgress: 0,
    };
  } else {
    progress = { ...progress, customerProgress: filled };
  }

  const claimed = claimMilestones(progress);
  return { progress: claimed.progress, served, milestones: claimed.milestones };
}

/** A big eater who is not filled in time starts over; nothing else is lost. */
export function resetCustomer(p: Progress): Progress {
  return { ...p, customerProgress: 0 };
}

export function buyTapUpgrade(p: Progress): Progress | null {
  const cost = tapUpgradeCost(p.tapLevel);
  if (p.scoops < cost) {
    return null;
  }
  return { ...p, scoops: p.scoops - cost, tapLevel: p.tapLevel + 1 };
}

export function buyFeeder(p: Progress, index: number): Progress | null {
  if (!Number.isInteger(index) || index < 0 || index >= FEEDERS.length) {
    return null;
  }
  const cost = feederCost(index, p.feeders[index]);
  if (p.scoops < cost) {
    return null;
  }
  const feeders = p.feeders.slice();
  feeders[index] += 1;
  return { ...p, scoops: p.scoops - cost, feeders };
}

export function prestigeSprinkles(runFed: number): number {
  if (runFed < PRESTIGE_THRESHOLD) {
    return 0;
  }
  return Math.floor(5 * Math.sqrt(runFed / PRESTIGE_THRESHOLD));
}

/** Launch a new flavor: the run resets, sprinkles and lifetime score stay. */
export function prestige(p: Progress): Progress | null {
  const gained = prestigeSprinkles(p.runFed);
  if (gained === 0) {
    return null;
  }
  return {
    ...createProgress(),
    lifetimeFed: p.lifetimeFed,
    sprinkles: p.sprinkles + gained,
    flavorIndex: p.flavorIndex + 1,
    milestonesClaimed: p.milestonesClaimed,
    dailyStreak: p.dailyStreak,
    lastDailyDay: p.lastDailyDay,
  };
}

export function offlineEarnings(p: Progress, elapsedMs: number): number {
  if (!(elapsedMs > 0)) {
    return 0;
  }
  const seconds = Math.min(elapsedMs, OFFLINE_CAP_MS) / 1_000;
  return Math.floor(idleRate(p) * seconds * OFFLINE_EFFICIENCY);
}

/** Offline income is banked as scoops; it does not serve customers. */
export function applyOfflineEarnings(p: Progress, elapsedMs: number): Progress {
  const amount = offlineEarnings(p, elapsedMs);
  return amount > 0 ? claimMilestones(earn(p, amount)).progress : p;
}

export function utcDay(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

export function dailyReward(p: Progress, streakDay: number): number {
  return Math.floor(Math.max(100, idleRate(p) * 600) * streakDay);
}

/** Returns null when today's reward was already claimed. */
export function claimDaily(
  p: Progress,
  nowMs: number,
): { progress: Progress; reward: number; streakDay: number } | null {
  const today = utcDay(nowMs);
  if (p.lastDailyDay >= today) {
    return null;
  }
  const continued = p.lastDailyDay === today - 1;
  const streakDay = continued ? (p.dailyStreak % DAILY_STREAK_LENGTH) + 1 : 1;
  const reward = dailyReward(p, streakDay);
  return {
    progress: {
      ...claimMilestones(earn(p, reward)).progress,
      dailyStreak: streakDay,
      lastDailyDay: today,
    },
    reward,
    streakDay,
  };
}

/**
 * The most a player could have earned between two syncs: tapping at the rate
 * cap with both boosts running the whole time, plus every customer bonus.
 * Rates only rise between syncs, so the newer state's rates bound the interval.
 */
export function maxPlausibleEarnings(
  prev: Progress,
  next: Progress,
  elapsedMs: number,
): number {
  const seconds = (Math.max(0, elapsedMs) + SYNC_GRACE_MS) / 1_000;
  const perSecond = Math.max(
    MAX_TAPS_PER_SECOND * tapValue(prev) + idleRate(prev),
    MAX_TAPS_PER_SECOND * tapValue(next) + idleRate(next),
  );
  const fed =
    perSecond * seconds * FRENZY_MULTIPLIER * SUGAR_RUSH_MULTIPLIER;
  let milestoneRewards = 0;
  for (
    let index = prev.milestonesClaimed;
    index < Math.min(next.milestonesClaimed, MILESTONES.length);
    index += 1
  ) {
    milestoneRewards += MILESTONES[index] * MILESTONE_REWARD_SHARE;
  }
  return fed * BONUS_HEADROOM + milestoneRewards;
}

export type SyncRejection =
  | "malformed"
  | "locked-field-changed"
  | "went-backwards"
  | "milestone-not-reached"
  | "earned-too-much"
  | "customers-too-fast"
  | "unpaid-purchase";

/**
 * Decides whether `next` could honestly follow `prev` after `elapsedMs` of
 * server-measured time. Prestige and the daily reward are applied by the
 * server itself, so the fields they own must not change here.
 */
export function validateSync(
  prev: Progress,
  next: unknown,
  elapsedMs: number,
): { ok: true; earned: number } | { ok: false; reason: SyncRejection } {
  if (!isProgress(next)) {
    return { ok: false, reason: "malformed" };
  }
  if (
    next.sprinkles !== prev.sprinkles ||
    next.flavorIndex !== prev.flavorIndex ||
    next.dailyStreak !== prev.dailyStreak ||
    next.lastDailyDay !== prev.lastDailyDay
  ) {
    return { ok: false, reason: "locked-field-changed" };
  }
  if (
    next.tapLevel < prev.tapLevel ||
    next.customer < prev.customer ||
    next.milestonesClaimed < prev.milestonesClaimed ||
    next.lifetimeFed < prev.lifetimeFed ||
    next.feeders.some((count, index) => count < prev.feeders[index])
  ) {
    return { ok: false, reason: "went-backwards" };
  }
  if (
    next.milestonesClaimed > prev.milestonesClaimed &&
    next.lifetimeFed < MILESTONES[next.milestonesClaimed - 1]
  ) {
    return { ok: false, reason: "milestone-not-reached" };
  }

  const earned = next.lifetimeFed - prev.lifetimeFed;
  const cap = maxPlausibleEarnings(prev, next, elapsedMs);
  const tolerance = 1e-6 * Math.max(1, next.lifetimeFed);
  if (
    earned > cap + tolerance ||
    Math.abs(next.runFed - prev.runFed - earned) > tolerance
  ) {
    return { ok: false, reason: "earned-too-much" };
  }

  let appetiteServed = -prev.customerProgress;
  for (let customer = prev.customer; customer < next.customer; customer += 1) {
    appetiteServed += appetiteFor(customer);
    if (appetiteServed > cap) {
      return { ok: false, reason: "customers-too-fast" };
    }
  }
  if (next.customerProgress >= appetiteFor(next.customer)) {
    return { ok: false, reason: "customers-too-fast" };
  }

  const spent = totalSpent(next) - totalSpent(prev);
  if (next.scoops > prev.scoops + earned - spent + tolerance) {
    return { ok: false, reason: "unpaid-purchase" };
  }

  return { ok: true, earned };
}
