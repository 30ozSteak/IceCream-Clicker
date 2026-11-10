"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BONUS_EVENTS,
  BONUS_UNLOCK,
  type BonusKind,
} from "../../lib/economy";

const KINDS: readonly BonusKind[] = ["golden", "sprinkle", "drone", "mystery"];
/** The first appearance after a page load or a purchase comes quickly. */
const FIRST_DELAY_MS: readonly [number, number] = [6_000, 14_000];
/** Gap between sprinkles within one shower. */
const SPRINKLE_STAGGER_MS = 420;
const SPRINKLE_COLORS = ["#ff5d8f", "#ffd23f", "#3ec7ff", "#7cf07a", "#c38bff", "#ff8a3d"];

const LABELS: Readonly<Record<BonusKind, string>> = {
  golden: "Catch the golden sandwich",
  sprinkle: "Catch the sprinkle",
  drone: "Catch the delivery drone",
  mystery: "Open the mystery cone",
};

interface Target {
  id: number;
  kind: BonusKind;
  /** Percent of the stage. */
  x: number;
  y: number;
  lifeMs: number;
  tilt: number;
  color: string;
}

type TargetStyle = CSSProperties & {
  "--x": string;
  "--y": string;
  "--life": string;
  "--tilt": string;
  "--sprinkle": string;
};

function between(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function makeTarget(id: number, kind: BonusKind): Target {
  const event = BONUS_EVENTS[kind];
  const target: Target = {
    id,
    kind,
    x: 50,
    y: 50,
    lifeMs: event.lifeMs,
    tilt: between(-40, 40),
    color: SPRINKLE_COLORS[Math.floor(Math.random() * SPRINKLE_COLORS.length)],
  };
  switch (kind) {
    case "golden":
      target.y = between(28, 58);
      break;
    case "sprinkle":
      target.x = between(10, 90);
      break;
    case "drone":
      target.y = between(24, 40);
      break;
    case "mystery":
      target.x = between(18, 82);
      target.y = between(34, 66);
      break;
  }
  return target;
}

/**
 * The catchable extras bought as unlocks. Each owned kind appears on its own
 * timer while the page is visible and play is not paused.
 */
export function BonusLayer({
  unlocks,
  paused,
  onCatch,
}: {
  /** Number of unlocks owned. */
  unlocks: number;
  paused: boolean;
  /** Called with the catch position in stage pixels. */
  onCatch: (kind: BonusKind, x: number, y: number) => void;
}) {
  const [targets, setTargets] = useState<Target[]>([]);
  const nextIdRef = useRef(1);
  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // One schedule per owned kind. Buying an unlock starts its schedule.
  useEffect(() => {
    const timers = new Set<number>();
    const later = (callback: () => void, delayMs: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delayMs);
      timers.add(timer);
    };

    const spawn = (kind: BonusKind) => {
      const event = BONUS_EVENTS[kind];
      for (let index = 0; index < event.count; index += 1) {
        later(() => {
          const target = makeTarget(nextIdRef.current, kind);
          nextIdRef.current += 1;
          setTargets((current) => [...current, target]);
        }, index * SPRINKLE_STAGGER_MS);
      }
    };

    const schedule = (kind: BonusKind, delayMs: number) => {
      later(() => {
        if (pausedRef.current || document.visibilityState !== "visible") {
          schedule(kind, 5_000);
          return;
        }
        spawn(kind);
        const event = BONUS_EVENTS[kind];
        schedule(kind, between(event.minDelayMs, event.maxDelayMs));
      }, delayMs);
    };

    for (const kind of KINDS) {
      if (unlocks > BONUS_UNLOCK[kind]) {
        schedule(kind, between(...FIRST_DELAY_MS));
      }
    }
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [unlocks]);

  const remove = (id: number) => {
    setTargets((current) => current.filter((target) => target.id !== id));
  };

  const handleCatch = (
    event: ReactPointerEvent<HTMLButtonElement>,
    target: Target,
  ) => {
    // A catch is not also a feed tap.
    event.stopPropagation();
    event.preventDefault();
    const stage = event.currentTarget.offsetParent;
    const box = event.currentTarget.getBoundingClientRect();
    const stageBox = stage?.getBoundingClientRect() ?? { left: 0, top: 0 };
    remove(target.id);
    onCatch(
      target.kind,
      box.left + box.width / 2 - stageBox.left,
      box.top + box.height / 2 - stageBox.top,
    );
  };

  return (
    <div className="bonus-layer">
      {targets.map((target) => {
        const style: TargetStyle = {
          "--x": `${target.x}%`,
          "--y": `${target.y}%`,
          "--life": `${target.lifeMs}ms`,
          "--tilt": `${target.tilt}deg`,
          "--sprinkle": target.color,
        };
        return (
          <button
            key={target.id}
            className={`bonus bonus-${target.kind}`}
            type="button"
            style={style}
            aria-label={LABELS[target.kind]}
            onPointerDown={(event) => handleCatch(event, target)}
            onClick={(event) => {
              // Keyboard activation; pointer catches already happened above.
              if (event.detail === 0) {
                const box = event.currentTarget.getBoundingClientRect();
                const stageBox =
                  event.currentTarget.offsetParent?.getBoundingClientRect() ?? {
                    left: 0,
                    top: 0,
                  };
                remove(target.id);
                onCatch(
                  target.kind,
                  box.left + box.width / 2 - stageBox.left,
                  box.top + box.height / 2 - stageBox.top,
                );
              }
            }}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) {
                remove(target.id);
              }
            }}
          >
            {target.kind === "golden" ? (
              <span className="sandwich-illustration bonus-golden-art" aria-hidden="true">
                <i />
              </span>
            ) : target.kind === "sprinkle" ? (
              <span className="bonus-sprinkle-art" aria-hidden="true" />
            ) : target.kind === "drone" ? (
              <span className="bonus-drone-art" aria-hidden="true">
                <span>🚁</span>
                <span className="bonus-drone-crate">📦</span>
              </span>
            ) : (
              <span className="bonus-mystery-art" aria-hidden="true">
                <span>🍦</span>
                <b>?</b>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
