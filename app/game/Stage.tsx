"use client";

/* Local, already-optimized portraits use an ordinary image so the mouth
   position can be computed from the exact rendered box. */
/* eslint-disable @next/next/no-img-element */

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  calculateCoverGeometry,
  normalizedImagePointToStage,
} from "../../lib/client/portrait-geometry";
import { formatAmount } from "../../lib/number-format";
import type { Portrait } from "../../lib/portraits";

const MAX_EFFECTS = 48;
const BITE_MS = 150;

export interface StageHandle {
  /** Big reaction text and bonus when a customer is full. */
  celebrate: (message: string, bonus: number) => void;
}

export function Stage({
  portrait,
  nextPortraitSrc,
  bigEater,
  reducedMotion,
  inert,
  onFeed,
  handleRef,
  children,
}: {
  portrait: Portrait | null;
  nextPortraitSrc: string | null;
  bigEater: boolean;
  reducedMotion: boolean;
  inert: boolean;
  /** Feeds one tap; returns the amount fed, or 0 if the tap did not count. */
  onFeed: () => number;
  handleRef: Ref<StageHandle>;
  children?: ReactNode;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const effectsRef = useRef<HTMLDivElement | null>(null);
  const mouthRef = useRef<{ x: number; y: number } | null>(null);
  const reactionTiltRef = useRef(false);

  const locateMouth = useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (
      !stage ||
      !image ||
      !portrait ||
      image.naturalWidth === 0 ||
      stage.clientWidth === 0 ||
      stage.clientHeight === 0
    ) {
      return;
    }
    const geometry = calculateCoverGeometry(
      stage.clientWidth,
      stage.clientHeight,
      image.naturalWidth,
      image.naturalHeight,
    );
    mouthRef.current = normalizedImagePointToStage(
      geometry,
      portrait.mouth.cx,
      portrait.mouth.cy,
    );
  }, [portrait]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    locateMouth();
    const observer = new ResizeObserver(locateMouth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [locateMouth]);

  useEffect(() => {
    if (!nextPortraitSrc) {
      return;
    }
    const preload = new window.Image();
    preload.decoding = "async";
    preload.src = nextPortraitSrc;
  }, [nextPortraitSrc]);

  const addEffect = useCallback((element: HTMLElement) => {
    const layer = effectsRef.current;
    if (!layer) {
      return false;
    }
    while (layer.childElementCount >= MAX_EFFECTS) {
      layer.firstElementChild?.remove();
    }
    layer.append(element);
    return true;
  }, []);

  const floatText = useCallback(
    (text: string, x: number, y: number, className: string) => {
      const element = document.createElement("span");
      element.className = className;
      element.textContent = text;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.addEventListener("animationend", () => element.remove(), {
        once: true,
      });
      addEffect(element);
    },
    [addEffect],
  );

  const feedAt = useCallback(
    (x: number, y: number) => {
      const amount = onFeed();
      if (amount <= 0) {
        return;
      }

      const drift = (Math.random() - 0.5) * 36;
      floatText(`+${formatAmount(Math.max(1, amount))}`, x + drift, y - 28, "fx-float");

      const mouth = mouthRef.current ?? { x, y };
      if (!reducedMotion) {
        const bite = document.createElement("span");
        bite.className = "sandwich-illustration fx-bite";
        bite.append(document.createElement("i"));
        if (addEffect(bite)) {
          const flight = bite.animate(
            [
              {
                transform: `translate(${x}px, ${y}px) scale(0.5) rotate(-12deg)`,
                opacity: 1,
              },
              {
                transform: `translate(${mouth.x}px, ${mouth.y}px) scale(0.3) rotate(6deg)`,
                opacity: 1,
                offset: 0.75,
              },
              {
                transform: `translate(${mouth.x}px, ${mouth.y}px) scale(0.08) rotate(6deg)`,
                opacity: 0,
              },
            ],
            { duration: BITE_MS, easing: "cubic-bezier(0.3, 0, 0.7, 1)" },
          );
          flight.onfinish = () => bite.remove();
          flight.oncancel = () => bite.remove();
        }
        imageRef.current?.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.03, 0.985)" },
            { transform: "scale(1)" },
          ],
          { duration: 130, delay: BITE_MS * 0.6, easing: "ease-out" },
        );
      }

      if (typeof navigator.vibrate === "function") {
        navigator.vibrate(8);
      }
    },
    [addEffect, floatText, onFeed, reducedMotion],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    feedAt(event.clientX - rect.left, event.clientY - rect.top);
  };

  useImperativeHandle(
    handleRef,
    () => ({
      celebrate: (message, bonus) => {
        const stage = stageRef.current;
        if (!stage) {
          return;
        }
        const mouth = mouthRef.current ?? {
          x: stage.clientWidth / 2,
          y: stage.clientHeight / 2,
        };
        reactionTiltRef.current = !reactionTiltRef.current;
        floatText(
          message,
          Math.min(Math.max(mouth.x, 110), stage.clientWidth - 110),
          Math.max(mouth.y, 190),
          `feed-reaction${reactionTiltRef.current ? " feed-reaction-tilt-right" : ""}`,
        );
        floatText(
          `+${formatAmount(bonus)} bonus`,
          stage.clientWidth / 2,
          Math.max(mouth.y, 190) + 34,
          "fx-float fx-float-bonus",
        );
      },
    }),
    [floatText],
  );

  return (
    <main
      className={`portrait-stage tap-stage${bigEater ? " tap-stage-big-eater" : ""}`}
      id="game"
      ref={stageRef}
      inert={inert ? true : undefined}
      aria-hidden={inert ? true : undefined}
      onPointerDown={handlePointerDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {portrait ? (
        <img
          className="portrait-photo"
          key={portrait.id}
          ref={imageRef}
          src={portrait.src}
          alt={portrait.alt}
          width="768"
          height="768"
          draggable={false}
          onLoad={locateMouth}
        />
      ) : null}
      <div className="fx-layer" ref={effectsRef} aria-hidden="true" />
      <button
        className="sr-only"
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => {
          const stage = stageRef.current;
          if (stage) {
            feedAt(stage.clientWidth / 2, stage.clientHeight * 0.7);
          }
        }}
      >
        Feed the customer
      </button>
      {children}
    </main>
  );
}
