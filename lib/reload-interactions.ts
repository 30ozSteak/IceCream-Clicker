import type {
  PackReloadDefinition,
  PopLaunchReloadDefinition,
  ReloadWindow,
  SpiralHoldReloadDefinition,
  TripleSnapReloadDefinition,
} from "./packs";

export type TripleSnapResult =
  | { status: "progress"; nextStep: number }
  | { status: "perfect"; nextStep: number }
  | { status: "missed"; nextStep: number };

export interface PopLaunchAttempt {
  startElapsedMs: number;
  endElapsedMs: number;
  startY: number;
  endY: number;
  gestureDurationMs: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isElapsedInWindow(
  elapsedMs: number,
  window: ReloadWindow,
): boolean {
  return elapsedMs >= window.startMs && elapsedMs <= window.endMs;
}

function isValidWindow(window: unknown, durationMs: number): window is ReloadWindow {
  if (!window || typeof window !== "object") {
    return false;
  }
  const candidate = window as Partial<ReloadWindow>;
  return (
    isFiniteNumber(candidate.startMs) &&
    candidate.startMs >= 0 &&
    isFiniteNumber(candidate.endMs) &&
    candidate.endMs > candidate.startMs &&
    candidate.endMs <= durationMs
  );
}

function windowsMatch(left: ReloadWindow, right: ReloadWindow): boolean {
  return left.startMs === right.startMs && left.endMs === right.endMs;
}

export function hasValidReloadInteractionConfig(
  reload: PackReloadDefinition,
): boolean {
  switch (reload.id) {
    case "spiral-hold": {
      const releaseWindow = reload.windows[0];
      return (
        reload.windows.length === 1 &&
        isValidWindow(reload.pressWindow, reload.durationMs) &&
        Boolean(releaseWindow && isValidWindow(releaseWindow, reload.durationMs)) &&
        reload.pressWindow.endMs < (releaseWindow?.startMs ?? 0) &&
        isFiniteNumber(reload.minHoldMs) &&
        reload.minHoldMs > 0 &&
        isFiniteNumber(reload.maxHoldMs) &&
        reload.maxHoldMs >= reload.minHoldMs
      );
    }
    case "triple-snap": {
      if (reload.beats.length !== 3 || reload.windows.length !== 1) {
        return false;
      }
      let previousEndMs = -1;
      for (const beat of reload.beats) {
        if (
          !isValidWindow(beat, reload.durationMs) ||
          beat.startMs <= previousEndMs
        ) {
          return false;
        }
        previousEndMs = beat.endMs;
      }
      const finalBeat = reload.beats.at(-1);
      return Boolean(finalBeat && windowsMatch(finalBeat, reload.windows[0]));
    }
    case "pop-launch": {
      const releaseWindow = reload.windows[0];
      return (
        reload.windows.length === 1 &&
        isValidWindow(reload.launchWindow, reload.durationMs) &&
        Boolean(releaseWindow && isValidWindow(releaseWindow, reload.durationMs)) &&
        reload.launchWindow.endMs < (releaseWindow?.startMs ?? 0) &&
        isFiniteNumber(reload.minTravelPx) &&
        reload.minTravelPx > 0 &&
        isFiniteNumber(reload.maxGestureMs) &&
        reload.maxGestureMs > 0
      );
    }
    default:
      return true;
  }
}

export function getReloadVisualWindows(
  reload: PackReloadDefinition,
): readonly ReloadWindow[] {
  switch (reload.id) {
    case "spiral-hold":
      return [reload.pressWindow, ...reload.windows];
    case "triple-snap":
      return reload.beats;
    case "pop-launch":
      return [reload.launchWindow, ...reload.windows];
    default:
      return reload.windows;
  }
}

export function evaluateSpiralHold(
  startElapsedMs: number,
  endElapsedMs: number,
  reload: SpiralHoldReloadDefinition,
): boolean {
  const heldForMs = endElapsedMs - startElapsedMs;
  return (
    isElapsedInWindow(startElapsedMs, reload.pressWindow) &&
    Boolean(
      reload.windows[0] &&
        isElapsedInWindow(endElapsedMs, reload.windows[0]),
    ) &&
    heldForMs >= reload.minHoldMs &&
    heldForMs <= reload.maxHoldMs
  );
}

export function advanceTripleSnap(
  completedSteps: number,
  elapsedMs: number,
  reload: TripleSnapReloadDefinition,
): TripleSnapResult {
  const targetBeat = reload.beats[completedSteps];
  if (!targetBeat || !isElapsedInWindow(elapsedMs, targetBeat)) {
    return { status: "missed", nextStep: completedSteps };
  }

  const nextStep = completedSteps + 1;
  return nextStep === reload.beats.length
    ? { status: "perfect", nextStep }
    : { status: "progress", nextStep };
}

export function evaluatePopLaunch(
  attempt: PopLaunchAttempt,
  reload: PopLaunchReloadDefinition,
): boolean {
  const releaseWindow = reload.windows[0];
  return (
    isElapsedInWindow(attempt.startElapsedMs, reload.launchWindow) &&
    Boolean(
      releaseWindow &&
        isElapsedInWindow(attempt.endElapsedMs, releaseWindow),
    ) &&
    attempt.startY - attempt.endY >= reload.minTravelPx &&
    attempt.gestureDurationMs >= 0 &&
    attempt.gestureDurationMs <= reload.maxGestureMs
  );
}
