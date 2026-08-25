import { env } from "cloudflare:workers";
import { ApiError } from "./api-error";

const DEVELOPMENT_ROUND_TOKEN_SECRET =
  "fatboy-feed-frenzy-development-fallback-only";

export function getRoundTokenSecret(): string {
  const configured = env.ROUND_TOKEN_SECRET;
  if (
    typeof configured === "string" &&
    new TextEncoder().encode(configured).byteLength >= 32
  ) {
    return configured;
  }

  if (
    typeof process !== "undefined" &&
    process.env.NODE_ENV === "development" &&
    configured === undefined
  ) {
    return DEVELOPMENT_ROUND_TOKEN_SECRET;
  }

  throw new ApiError(
    503,
    "GAME_CONFIGURATION_ERROR",
    "ROUND_TOKEN_SECRET must be configured as a secret with at least 32 UTF-8 bytes.",
    { retryable: true },
  );
}
