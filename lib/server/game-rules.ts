import type { MouthTarget } from "../portraits";
import type { RoundTokenClaims } from "../game-types";

export const MIN_FEED_INTERVAL_MS = 200;
export const SANDWICHES_PER_PACK = 6;
export const ACTIVE_RELOAD_BONUS_TREATS = 1;
export const MAX_TREATS_PER_PACK =
  SANDWICHES_PER_PACK + ACTIVE_RELOAD_BONUS_TREATS;
export const PACK_RELOAD_DURATION_MS = 2_400;
export const ACTIVE_RELOAD_START_MS = 1_320;
export const ACTIVE_RELOAD_END_MS = 1_800;
export const ACTIVE_RELOAD_END_GRACE_MS = 300;

export type PackReloadTiming = "waiting" | "perfect" | "standard";

export function classifyPackReload(elapsedMs: number): PackReloadTiming {
  if (!Number.isFinite(elapsedMs)) {
    throw new Error("Reload timing must be a finite number.");
  }

  if (elapsedMs < ACTIVE_RELOAD_START_MS) {
    return "waiting";
  }
  if (elapsedMs <= ACTIVE_RELOAD_END_MS + ACTIVE_RELOAD_END_GRACE_MS) {
    return "perfect";
  }
  if (elapsedMs < PACK_RELOAD_DURATION_MS) {
    return "waiting";
  }
  return "standard";
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
