"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BIG_EATER_TIME_MS,
  type BonusKind,
  BONUS_UNLOCK,
  type FeedResult,
  FRENZY_DECAY_PER_SECOND,
  FRENZY_DURATION_MS,
  FRENZY_MULTIPLIER,
  FRENZY_PER_TAP,
  type Progress,
  SUGAR_RUSH_DURATION_MS,
  SUGAR_RUSH_MULTIPLIER,
  UNLOCK_BRAIN_FREEZE,
  applyOfflineEarnings,
  bonusPayout,
  buyFeeder as purchaseFeeder,
  buyTapUpgrade as purchaseTapUpgrade,
  buyUnlock as purchaseUnlock,
  createProgress,
  feed,
  hasUnlock,
  idleRate,
  isBigEater,
  resetCustomer,
  rollMystery,
  tapValue,
  upgradeProgress,
} from "../../lib/economy";
import { formatAmount } from "../../lib/number-format";

const TICK_MS = 100;
const SAVE_INTERVAL_MS = 2_000;
/** A gap this long between ticks means the tab was asleep, not lagging. */
const AWAY_THRESHOLD_MS = 5_000;

export interface Boosts {
  /** Brain Freeze meter, 0–1, while it is filling. */
  frenzyMeter: number;
  /** Time left on an active boost, 0 when it is off. */
  frenzyRemainingMs: number;
  rushRemainingMs: number;
}

const NO_BOOSTS: Boosts = {
  frenzyMeter: 0,
  frenzyRemainingMs: 0,
  rushRemainingMs: 0,
};

export interface BonusResult {
  /** Short text shown where the target was caught. */
  label: string;
  tone: "boost" | "bonus";
}

export interface EngineEvents {
  onServed?: (served: NonNullable<FeedResult["served"]>) => void;
  onMilestone?: (milestone: FeedResult["milestones"][number]) => void;
  onBigEaterEscaped?: () => void;
  onAwayEarnings?: (amount: number) => void;
  onFrenzy?: () => void;
}

interface StoredGame {
  progress: Progress;
  savedAtMs: number;
}

function readStoredGame(key: string): StoredGame | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { progress?: unknown; savedAtMs?: unknown };
    const progress = upgradeProgress(parsed.progress);
    if (progress && typeof parsed.savedAtMs === "number") {
      return { progress, savedAtMs: parsed.savedAtMs };
    }
  } catch {
    // Unreadable or blocked storage simply means a fresh start.
  }
  return null;
}

function writeStoredGame(key: string, progress: Progress): void {
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ progress, savedAtMs: Date.now() } satisfies StoredGame),
    );
  } catch {
    // Private windows may refuse storage; play continues unsaved.
  }
}

function sameBoosts(a: Boosts, b: Boosts): boolean {
  return (
    a.frenzyMeter === b.frenzyMeter &&
    a.frenzyRemainingMs === b.frenzyRemainingMs &&
    a.rushRemainingMs === b.rushRemainingMs
  );
}

/**
 * Runs the whole game on the device: taps, idle income, boosts, bonus
 * payouts, the big-eater timer, and saving. `storageKey` is null until the
 * player is known.
 */
export function useGameEngine(
  storageKey: string | null,
  startingLifetimeFed: number,
  events: EngineEvents,
) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [bigEaterRemainingMs, setBigEaterRemainingMs] = useState<number | null>(
    null,
  );
  const [boosts, setBoosts] = useState<Boosts>(NO_BOOSTS);
  const progressRef = useRef<Progress | null>(null);
  const bigEaterDeadlineRef = useRef<number | null>(null);
  const frenzyMeterRef = useRef(0);
  const frenzyUntilRef = useRef(0);
  const rushUntilRef = useRef(0);
  const dirtyRef = useRef(false);
  const eventsRef = useRef(events);

  useEffect(() => {
    eventsRef.current = events;
  });

  const multiplierAt = useCallback((now: number) => {
    return (
      (now < frenzyUntilRef.current ? FRENZY_MULTIPLIER : 1) *
      (now < rushUntilRef.current ? SUGAR_RUSH_MULTIPLIER : 1)
    );
  }, []);

  const publishBoosts = useCallback((now: number) => {
    const next: Boosts = {
      frenzyMeter: Math.round(frenzyMeterRef.current * 100) / 100,
      frenzyRemainingMs: Math.max(0, Math.ceil((frenzyUntilRef.current - now) / 100) * 100),
      rushRemainingMs: Math.max(0, Math.ceil((rushUntilRef.current - now) / 100) * 100),
    };
    setBoosts((current) => (sameBoosts(current, next) ? current : next));
  }, []);

  const startFrenzy = useCallback(
    (now: number) => {
      frenzyUntilRef.current = now + FRENZY_DURATION_MS;
      frenzyMeterRef.current = 0;
      eventsRef.current.onFrenzy?.();
      publishBoosts(now);
    },
    [publishBoosts],
  );

  const armBigEater = useCallback((customer: number) => {
    if (isBigEater(customer)) {
      bigEaterDeadlineRef.current = performance.now() + BIG_EATER_TIME_MS;
      setBigEaterRemainingMs(BIG_EATER_TIME_MS);
    } else {
      bigEaterDeadlineRef.current = null;
      setBigEaterRemainingMs(null);
    }
  }, []);

  const commit = useCallback((next: Progress) => {
    progressRef.current = next;
    dirtyRef.current = true;
    setProgress(next);
  }, []);

  const applyFeed = useCallback(
    (result: FeedResult) => {
      commit(result.progress);
      if (result.served) {
        armBigEater(result.progress.customer);
        eventsRef.current.onServed?.(result.served);
      }
      for (const milestone of result.milestones) {
        eventsRef.current.onMilestone?.(milestone);
      }
    },
    [armBigEater, commit],
  );

  // Load the saved game once the player is known.
  useEffect(() => {
    if (!storageKey) {
      return;
    }
    const stored = readStoredGame(storageKey);
    let loaded = stored?.progress ?? createProgress(startingLifetimeFed);
    if (stored) {
      const banked = applyOfflineEarnings(loaded, Date.now() - stored.savedAtMs);
      const away = banked.lifetimeFed - loaded.lifetimeFed;
      loaded = banked;
      if (away > 0) {
        eventsRef.current.onAwayEarnings?.(away);
      }
    }
    progressRef.current = loaded;
    dirtyRef.current = true;
    // Local storage only exists in the browser, so this cannot be initial state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProgress(loaded);
    armBigEater(loaded.customer);
    // The starting score only matters for the very first load of a player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armBigEater, storageKey]);

  // Idle income, boost timers, and the big-eater countdown.
  useEffect(() => {
    if (!storageKey) {
      return;
    }
    let last = performance.now();
    const interval = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - last;
      last = now;
      const current = progressRef.current;
      if (!current) {
        return;
      }

      if (elapsed > AWAY_THRESHOLD_MS) {
        frenzyMeterRef.current = 0;
        publishBoosts(now);
        const banked = applyOfflineEarnings(current, elapsed);
        const away = banked.lifetimeFed - current.lifetimeFed;
        if (away > 0) {
          commit(banked);
          eventsRef.current.onAwayEarnings?.(away);
        }
        if (bigEaterDeadlineRef.current !== null) {
          armBigEater(current.customer);
        }
        return;
      }

      if (now >= frenzyUntilRef.current && frenzyMeterRef.current > 0) {
        frenzyMeterRef.current = Math.max(
          0,
          frenzyMeterRef.current - (FRENZY_DECAY_PER_SECOND * elapsed) / 1_000,
        );
      }
      publishBoosts(now);

      const rate = idleRate(current);
      if (rate > 0) {
        applyFeed(feed(current, (rate * multiplierAt(now) * elapsed) / 1_000));
      }

      const deadline = bigEaterDeadlineRef.current;
      if (deadline !== null) {
        const remaining = deadline - now;
        if (remaining <= 0) {
          const latest = progressRef.current;
          if (latest && isBigEater(latest.customer)) {
            commit(resetCustomer(latest));
            armBigEater(latest.customer);
            eventsRef.current.onBigEaterEscaped?.();
          }
        } else {
          setBigEaterRemainingMs(remaining);
        }
      }
    }, TICK_MS);
    return () => window.clearInterval(interval);
  }, [applyFeed, armBigEater, commit, multiplierAt, publishBoosts, storageKey]);

  // Saving.
  useEffect(() => {
    if (!storageKey) {
      return;
    }
    const save = () => {
      if (dirtyRef.current && progressRef.current) {
        writeStoredGame(storageKey, progressRef.current);
        dirtyRef.current = false;
      }
    };
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        save();
      }
    };
    const interval = window.setInterval(save, SAVE_INTERVAL_MS);
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      save();
      window.clearInterval(interval);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [storageKey]);

  /** Feeds one tap and returns how much it was worth (0 when not ready). */
  const tap = useCallback((): number => {
    const current = progressRef.current;
    if (!current) {
      return 0;
    }
    const now = performance.now();
    if (
      hasUnlock(current, UNLOCK_BRAIN_FREEZE) &&
      now >= frenzyUntilRef.current
    ) {
      frenzyMeterRef.current = Math.min(1, frenzyMeterRef.current + FRENZY_PER_TAP);
      if (frenzyMeterRef.current >= 1) {
        startFrenzy(now);
      } else {
        publishBoosts(now);
      }
    }
    const amount = tapValue(current) * multiplierAt(now);
    applyFeed(feed(current, amount));
    return amount;
  }, [applyFeed, multiplierAt, publishBoosts, startFrenzy]);

  /** Pays out a caught bonus target. Returns null if it no longer counts. */
  const claimBonus = useCallback(
    (kind: BonusKind): BonusResult | null => {
      const current = progressRef.current;
      if (!current || !hasUnlock(current, BONUS_UNLOCK[kind])) {
        return null;
      }
      const now = performance.now();
      const startRush = () => {
        rushUntilRef.current = now + SUGAR_RUSH_DURATION_MS;
        publishBoosts(now);
      };
      const payLump = (amount: number) => {
        applyFeed(feed(current, amount));
        return formatAmount(amount);
      };

      switch (kind) {
        case "golden":
          startRush();
          return { label: `Sugar Rush ×${SUGAR_RUSH_MULTIPLIER}`, tone: "boost" };
        case "sprinkle":
          return { label: `+${payLump(bonusPayout(current, kind))}`, tone: "bonus" };
        case "drone":
          return { label: `+${payLump(bonusPayout(current, kind))}`, tone: "bonus" };
        case "mystery": {
          const outcome = rollMystery();
          if (outcome === "rush") {
            startRush();
            return { label: `Sugar Rush ×${SUGAR_RUSH_MULTIPLIER}`, tone: "boost" };
          }
          if (outcome === "freeze") {
            startFrenzy(now);
            return { label: `Brain Freeze ×${FRENZY_MULTIPLIER}`, tone: "boost" };
          }
          return { label: `Jackpot +${payLump(bonusPayout(current, kind))}`, tone: "bonus" };
        }
      }
    },
    [applyFeed, publishBoosts, startFrenzy],
  );

  const buyTapUpgrade = useCallback((): boolean => {
    const next = progressRef.current && purchaseTapUpgrade(progressRef.current);
    if (!next) {
      return false;
    }
    commit(next);
    return true;
  }, [commit]);

  const buyFeeder = useCallback(
    (index: number): boolean => {
      const next =
        progressRef.current && purchaseFeeder(progressRef.current, index);
      if (!next) {
        return false;
      }
      commit(next);
      return true;
    },
    [commit],
  );

  const buyUnlock = useCallback((): boolean => {
    const next = progressRef.current && purchaseUnlock(progressRef.current);
    if (!next) {
      return false;
    }
    commit(next);
    return true;
  }, [commit]);

  return {
    progress,
    bigEaterRemainingMs,
    boosts,
    tap,
    claimBonus,
    buyTapUpgrade,
    buyFeeder,
    buyUnlock,
  };
}
