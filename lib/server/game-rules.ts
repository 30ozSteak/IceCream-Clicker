import type { MouthTarget } from "../portraits";
import type { RoundTokenClaims } from "../game-types";

export const MIN_FEED_INTERVAL_MS = 200;

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
