"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BIG_EATER_TIME_MS,
  type FeedResult,
  type Progress,
  applyOfflineEarnings,
  buyFeeder as purchaseFeeder,
  buyTapUpgrade as purchaseTapUpgrade,
  createProgress,
  feed,
  idleRate,
  isBigEater,
  isProgress,
  resetCustomer,
  tapValue,
} from "../../lib/economy";

const TICK_MS = 100;
const SAVE_INTERVAL_MS = 2_000;
/** A gap this long between ticks means the tab was asleep, not lagging. */
const AWAY_THRESHOLD_MS = 5_000;

export interface EngineEvents {
  onServed?: (served: NonNullable<FeedResult["served"]>) => void;
  onMilestone?: (milestone: FeedResult["milestones"][number]) => void;
  onBigEaterEscaped?: () => void;
  onAwayEarnings?: (amount: number) => void;
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
    const parsed = JSON.parse(raw) as Partial<StoredGame>;
    if (isProgress(parsed.progress) && typeof parsed.savedAtMs === "number") {
      return { progress: parsed.progress, savedAtMs: parsed.savedAtMs };
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

/**
 * Runs the whole game on the device: taps, idle income, the big-eater timer,
 * and saving. `storageKey` is null until the player is known.
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
  const progressRef = useRef<Progress | null>(null);
  const bigEaterDeadlineRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const eventsRef = useRef(events);

  useEffect(() => {
    eventsRef.current = events;
  });

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

  // Idle income and the big-eater countdown.
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

      const rate = idleRate(current);
      if (rate > 0) {
        applyFeed(feed(current, (rate * elapsed) / 1_000));
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
  }, [applyFeed, armBigEater, commit, storageKey]);

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
    const amount = tapValue(current);
    applyFeed(feed(current, amount));
    return amount;
  }, [applyFeed]);

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

  return { progress, bigEaterRemainingMs, tap, buyTapUpgrade, buyFeeder };
}
