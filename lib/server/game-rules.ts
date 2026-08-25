import type { MouthTarget } from "../portraits";
import type { RoundTokenClaims } from "../game-types";
import { PACK_CATALOG, type PackDefinition } from "../packs.ts";

export const MIN_FEED_INTERVAL_MS = 200;
export const SANDWICHES_PER_PACK = PACK_CATALOG[0].quantity;
export const PACK_RELOAD_DURATION_MS = PACK_CATALOG[0].reload.durationMs;
export const ACTIVE_RELOAD_START_MS =
  PACK_CATALOG[0].reload.windows[0].startMs;
export const ACTIVE_RELOAD_END_MS = PACK_CATALOG[0].reload.windows[0].endMs;
export const ACTIVE_RELOAD_END_GRACE_MS = 300;

export type PackReloadTiming = "waiting" | "perfect" | "standard";

export function classifyPackReload(
  elapsedMs: number,
  pack: PackDefinition = PACK_CATALOG[0],
): PackReloadTiming {
  if (!Number.isFinite(elapsedMs)) {
    throw new Error("Reload timing must be a finite number.");
  }

  if (
    pack.reload.windows.some(
      (window) =>
        elapsedMs >= window.startMs &&
        elapsedMs <= window.endMs + ACTIVE_RELOAD_END_GRACE_MS,
    )
  ) {
    return "perfect";
  }
  if (elapsedMs < pack.reload.durationMs) {
    return "waiting";
  }
  return "standard";
}

export function nextReloadOpportunityMs(
  elapsedMs: number,
  pack: PackDefinition,
): number {
  const upcomingWindow = pack.reload.windows.find(
    (window) => elapsedMs < window.startMs,
  );
  return upcomingWindow?.startMs ?? pack.reload.durationMs;
}

export function isNormalizedCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isPointInsideMouth(
  x: number,
  y: number,
  mouth: MouthTarget,
): boolean {
  if (mouth.rx <= 0 || mouth.ry <= 0) {
    return false;
  }
  const normalizedX = (x - mouth.cx) / mouth.rx;
  const normalizedY = (y - mouth.cy) / mouth.ry;
  return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
}

export function claimsMatchRound(
  claims: RoundTokenClaims,
  player: { id: string; scoreVersion: number; currentImageId: string },
): boolean {
  return (
    claims.playerId === player.id &&
    claims.scoreVersion === player.scoreVersion &&
    claims.portraitId === player.currentImageId
  );
}

export function feedWaitMs(lastAcceptedAtMs: number | null, nowMs: number): number {
  if (lastAcceptedAtMs === null) {
    return 0;
  }
  return Math.max(0, MIN_FEED_INTERVAL_MS - (nowMs - lastAcceptedAtMs));
}
