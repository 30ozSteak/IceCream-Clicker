import {
  and,
  asc,
  desc,
  eq,
  isNull,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "../../db";
import { players, type PlayerRow } from "../../db/schema";
import {
  PORTRAITS,
  PORTRAIT_BY_ID,
  type Portrait,
} from "../portraits";
import {
  getPackById,
  getPackForOrdinal,
  getPacksCleared,
  PACK_CATALOG,
  PACK_CATALOG_VERSION,
  type PackDefinition,
} from "../packs";
import type {
  DeletePlayerResponse,
  FeedRequest,
  FeedResponse,
  GameStateResponse,
  LeaderboardResponse,
  PackReloadResponse,
  PackReloadTokenClaims,
  PlayerState,
  PortraitPreview,
  UpdatePlayerResponse,
} from "../game-types";
import { ApiError } from "./api-error";
import {
  claimsMatchRound,
  classifyPackReload,
  feedWaitMs,
  isNormalizedCoordinate,
  isPointInsideMouth,
  MIN_FEED_INTERVAL_MS,
  nextReloadOpportunityMs,
  SANDWICHES_PER_PACK,
} from "./game-rules";
import { readCookie, SESSION_COOKIE_NAME } from "./http";
import { validateNickname } from "./nickname";
import { getRoundTokenSecret } from "./runtime-env";
import {
  createSessionToken,
  hashSessionToken,
  isSessionToken,
  randomPublicTag,
  secureRandomIndex,
  signPackReloadToken,
  signRoundToken,
  verifyPackReloadToken,
  verifyRoundToken,
} from "./security";

const ROUND_TOKEN_TTL_MS = 5 * 60 * 1_000;
const PACK_RELOAD_TOKEN_TTL_MS = 5 * 60 * 1_000;
const MAX_PLAYER_CREATION_ATTEMPTS = 8;

type GameDb = ReturnType<typeof getDb>;

interface SessionPlayer {
  tokenHash: string;
  player: PlayerRow;
}

interface GameSessionResult {
  game: GameStateResponse;
  newSessionToken: string | null;
}

function displayName(player: Pick<PlayerRow, "nickname" | "publicTag">): string {
  return `${player.nickname ?? "Player"} #${player.publicTag}`;
}

function playerState(player: PlayerRow): PlayerState {
  const storedCurrentPack =
    getPackById(player.currentPackId) ?? PACK_CATALOG[0];
  // The previous game could award a seventh treat in a printed six-pack.
  // Preserve that earned inventory without showing an impossible 7/6 counter;
  // newly opened progression boxes always use their printed quantity exactly.
  const currentPack =
    player.packTreatsRemaining > storedCurrentPack.quantity
      ? { ...storedCurrentPack, quantity: player.packTreatsRemaining }
      : storedCurrentPack;
  return {
    nickname: player.nickname,
    publicTag: player.publicTag,
    displayName: displayName(player),
    sandwichesFed: player.sandwichesFed,
    sandwichesRemaining: player.packTreatsRemaining,
    packsCleared: getPacksCleared(
      player.packsOpened,
      player.packTreatsRemaining,
    ),
    currentPack,
    nextPack: getPackForOrdinal(player.packsOpened + 1),
    scoreVersion: player.scoreVersion,
  };
}

function portraitPreview(portrait: Portrait): PortraitPreview {
  return { id: portrait.id, src: portrait.src, alt: portrait.alt };
}

function requirePortraitManifest(): void {
  if (PORTRAITS.length < 2) {
    throw new Error("The portrait manifest must contain at least two portraits.");
  }
}

function pickPortrait(excludedIds: ReadonlySet<string>): Portrait {
  const candidates = PORTRAITS.filter((portrait) => !excludedIds.has(portrait.id));
  if (candidates.length === 0) {
    throw new Error("The portrait manifest does not contain enough distinct portraits.");
  }
  return candidates[secureRandomIndex(candidates.length)];
}

function pickPortraitPair(): readonly [Portrait, Portrait] {
  requirePortraitManifest();
  const current = PORTRAITS[secureRandomIndex(PORTRAITS.length)];
  const next = pickPortrait(new Set([current.id]));
  return [current, next];
}

function pickFollowingPortrait(player: PlayerRow): Portrait {
  const excluded = new Set([player.currentImageId, player.nextImageId]);
  if (PORTRAITS.length <= excluded.size) {
    excluded.delete(player.currentImageId);
  }
  return pickPortrait(excluded);
}

function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (
      (current as Error & { code?: string }).code === "23505" ||
      current.message.includes("UNIQUE constraint failed") ||
      current.message.includes("duplicate key value violates unique constraint")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function findSessionPlayer(
  db: GameDb,
  request: Request,
): Promise<SessionPlayer | null> {
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!isSessionToken(token)) {
    return null;
  }

  const tokenHash = await hashSessionToken(token);
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.sessionTokenHash, tokenHash))
    .limit(1);

  return player ? { tokenHash, player } : null;
}

async function requireSessionPlayer(
  db: GameDb,
  request: Request,
): Promise<SessionPlayer> {
  const session = await findSessionPlayer(db, request);
  if (!session) {
    throw new ApiError(
      401,
      "SESSION_REQUIRED",
      "Your game session is missing or no longer valid. Reload the game to start a session.",
      { retryable: true },
    );
  }
  return session;
}

async function createPlayer(
  db: GameDb,
): Promise<{ player: PlayerRow; sessionToken: string }> {
  requirePortraitManifest();

  for (let attempt = 0; attempt < MAX_PLAYER_CREATION_ATTEMPTS; attempt += 1) {
    const sessionToken = createSessionToken();
    const sessionTokenHash = await hashSessionToken(sessionToken);
    const [current, next] = pickPortraitPair();
    const nowMs = Date.now();

    try {
      const [player] = await db
        .insert(players)
        .values({
          id: crypto.randomUUID(),
          sessionTokenHash,
          nickname: null,
          publicTag: randomPublicTag(),
          sandwichesFed: 0,
          sandwichesThrown: 0,
          packsOpened: 1,
          packTreatsRemaining: SANDWICHES_PER_PACK,
          currentPackId: PACK_CATALOG[0].id,
          scoreVersion: 0,
          currentImageId: current.id,
          nextImageId: next.id,
          lastAcceptedAtMs: null,
          lastThrowAtMs: null,
          leaderboardVisible: true,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .returning();

      if (!player) {
        throw new Error("The database did not return the newly created player.");
      }
      return { player, sessionToken };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }

  throw new ApiError(
    503,
    "SESSION_CREATION_FAILED",
    "A unique game session could not be created. Please try again.",
    { retryable: true },
  );
}

async function repairPortraitState(db: GameDb, player: PlayerRow): Promise<PlayerRow> {
  const current = PORTRAIT_BY_ID.get(player.currentImageId);
  const next = PORTRAIT_BY_ID.get(player.nextImageId);
  if (current && next && current.id !== next.id) {
    return player;
  }

  const [replacementCurrent, replacementNext] = pickPortraitPair();
  const [updated] = await db
    .update(players)
    .set({
      currentImageId: replacementCurrent.id,
      nextImageId: replacementNext.id,
      scoreVersion: sql`${players.scoreVersion} + 1`,
    })
    .where(
      and(
        eq(players.id, player.id),
        eq(players.scoreVersion, player.scoreVersion),
      ),
    )
    .returning();

  if (updated) {
    return updated;
  }

  const [latest] = await db
    .select()
    .from(players)
    .where(eq(players.id, player.id))
    .limit(1);
  if (!latest) {
    throw new ApiError(401, "SESSION_REQUIRED", "The game session no longer exists.", {
      retryable: true,
    });
  }
  return latest;
}

async function buildGameState(
  player: PlayerRow,
  nowMs = Date.now(),
): Promise<GameStateResponse> {
  const current = PORTRAIT_BY_ID.get(player.currentImageId);
  const next = PORTRAIT_BY_ID.get(player.nextImageId);
  if (!current || !next || current.id === next.id) {
    throw new Error("The portrait manifest does not match the stored game round.");
  }

  const expiresAtMs = nowMs + ROUND_TOKEN_TTL_MS;
  const roundToken = await signRoundToken(
    {
      playerId: player.id,
      scoreVersion: player.scoreVersion,
      portraitId: player.currentImageId,
      expiresAtMs,
    },
    getRoundTokenSecret(),
  );

  return {
    player: playerState(player),
    round: {
      currentPortrait: current,
      nextPortrait: portraitPreview(next),
      roundToken,
      expiresAtMs,
    },
  };
}

export async function getOrCreateGame(request: Request): Promise<GameSessionResult> {
  const db = getDb();
  const existing = await findSessionPlayer(db, request);
  if (existing) {
    const repaired = await repairPortraitState(db, existing.player);
    return { game: await buildGameState(repaired), newSessionToken: null };
  }

  const created = await createPlayer(db);
  return {
    game: await buildGameState(created.player),
    newSessionToken: created.sessionToken,
  };
}

function assertOnlyKeys(
  payload: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const keys = Object.keys(payload);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new ApiError(
      400,
      "INVALID_BODY",
      `The request body must contain only: ${Array.from(allowed).join(", ")}.`,
    );
  }
}

export async function updatePlayerNickname(
  request: Request,
  payload: Record<string, unknown>,
): Promise<UpdatePlayerResponse> {
  assertOnlyKeys(payload, new Set(["nickname"]));
  const validated = validateNickname(payload.nickname);
  if (!validated.ok) {
    const message =
      validated.reason === "length"
        ? "Nickname must be 2–16 characters."
        : validated.reason === "characters"
          ? "Nickname can contain only letters, numbers, and spaces."
          : validated.reason === "blocked"
            ? "That nickname is not available. Choose a different one."
            : "A nickname is required.";
    throw new ApiError(422, "INVALID_NICKNAME", message, {
      details: { reason: validated.reason },
    });
  }

  const db = getDb();
  const session = await requireSessionPlayer(db, request);
  const [updated] = await db
    .update(players)
    .set({ nickname: validated.nickname, updatedAtMs: Date.now() })
    .where(
      and(
        eq(players.id, session.player.id),
        eq(players.sessionTokenHash, session.tokenHash),
      ),
    )
    .returning();

  if (!updated) {
    throw new ApiError(401, "SESSION_REQUIRED", "The game session no longer exists.", {
      retryable: true,
    });
  }
  return { player: playerState(updated) };
}

function parseFeedRequest(payload: Record<string, unknown>): FeedRequest {
  assertOnlyKeys(payload, new Set(["roundToken", "portraitId", "x", "y"]));
  if (typeof payload.roundToken !== "string" || payload.roundToken.length > 1_024) {
    throw new ApiError(400, "INVALID_ROUND_TOKEN", "The round token is invalid.");
  }
  if (
    typeof payload.portraitId !== "string" ||
    payload.portraitId.length === 0 ||
    payload.portraitId.length > 128
  ) {
    throw new ApiError(400, "INVALID_PORTRAIT", "The portrait ID is invalid.");
  }
  if (!isNormalizedCoordinate(payload.x) || !isNormalizedCoordinate(payload.y)) {
    throw new ApiError(
      400,
      "INVALID_COORDINATES",
      "Click coordinates must be finite numbers between 0 and 1.",
    );
  }

  return {
    roundToken: payload.roundToken,
    portraitId: payload.portraitId,
    x: payload.x,
    y: payload.y,
  };
}

function roundTokenError(reason: "malformed" | "invalid-signature" | "expired"): ApiError {
  if (reason === "expired") {
    return new ApiError(
      409,
      "ROUND_EXPIRED",
      "This round expired. Reload the current game state and try again.",
      { retryable: true },
    );
  }
  return new ApiError(400, "INVALID_ROUND_TOKEN", "The round token is invalid.");
}

function tooFastError(waitMs: number): ApiError {
  return new ApiError(
    429,
    "FEED_TOO_FAST",
    "Please wait for the sandwich animation before feeding again.",
    {
      retryable: true,
      details: { retryAfterMs: Math.max(1, Math.ceil(waitMs)) },
    },
  );
}

export async function feedPlayer(
  request: Request,
  payload: Record<string, unknown>,
): Promise<FeedResponse> {
  const feed = parseFeedRequest(payload);
  const db = getDb();
  const session = await requireSessionPlayer(db, request);
  if (session.player.nickname === null) {
    throw new ApiError(
      409,
      "NICKNAME_REQUIRED",
      "Choose a nickname before feeding your first sandwich.",
    );
  }
  if (session.player.packTreatsRemaining === 0) {
    throw new ApiError(
      409,
      "PACK_EMPTY",
      "Open a new FatBoy pack before feeding another sandwich.",
    );
  }

  const verification = await verifyRoundToken(
    feed.roundToken,
    getRoundTokenSecret(),
  );
  if (!verification.ok) {
    throw roundTokenError(verification.reason);
  }

  if (verification.claims.playerId !== session.player.id) {
    throw new ApiError(400, "INVALID_ROUND_TOKEN", "The round token is invalid.");
  }
  if (
    !claimsMatchRound(verification.claims, session.player) ||
    feed.portraitId !== verification.claims.portraitId
  ) {
    throw new ApiError(
      409,
      "ROUND_STALE",
      "That round has already changed. Reload the current game state.",
      { retryable: true },
    );
  }

  const portrait = PORTRAIT_BY_ID.get(session.player.currentImageId);
  if (!portrait) {
    throw new ApiError(
      409,
      "ROUND_STALE",
      "That portrait is no longer part of the current round.",
      { retryable: true },
    );
  }
  const outcome = isPointInsideMouth(feed.x, feed.y, portrait.mouth)
    ? "hit"
    : "miss";

  const nowMs = Date.now();
  const waitMs = feedWaitMs(session.player.lastThrowAtMs, nowMs);
  if (waitMs > 0) {
    throw tooFastError(waitMs);
  }

  const following =
    outcome === "hit" ? pickFollowingPortrait(session.player) : null;
  const [updated] = await db
    .update(players)
    .set({
      sandwichesThrown: sql`${players.sandwichesThrown} + 1`,
      packTreatsRemaining: sql`${players.packTreatsRemaining} - 1`,
      ...(outcome === "hit"
        ? {
            sandwichesFed: sql`${players.sandwichesFed} + 1`,
            currentImageId: session.player.nextImageId,
            nextImageId: following!.id,
            lastAcceptedAtMs: nowMs,
          }
        : {}),
      scoreVersion: sql`${players.scoreVersion} + 1`,
      lastThrowAtMs: nowMs,
      updatedAtMs: nowMs,
    })
    .where(
      and(
        eq(players.id, session.player.id),
        eq(players.sessionTokenHash, session.tokenHash),
        eq(players.scoreVersion, verification.claims.scoreVersion),
        eq(players.currentImageId, verification.claims.portraitId),
        sql`${players.packTreatsRemaining} > 0`,
        or(
          isNull(players.lastThrowAtMs),
          lte(players.lastThrowAtMs, nowMs - MIN_FEED_INTERVAL_MS),
        ),
      ),
    )
    .returning();

  if (!updated) {
    const [latest] = await db
      .select()
      .from(players)
      .where(
        and(
          eq(players.id, session.player.id),
          eq(players.sessionTokenHash, session.tokenHash),
        ),
      )
      .limit(1);

    if (!latest) {
      throw new ApiError(401, "SESSION_REQUIRED", "The game session no longer exists.", {
        retryable: true,
      });
    }
    if (latest.packTreatsRemaining === 0) {
      throw new ApiError(
        409,
        "PACK_EMPTY",
        "Open a new FatBoy pack before feeding another sandwich.",
      );
    }
    const latestWaitMs = feedWaitMs(latest.lastThrowAtMs, Date.now());
    if (
      latest.scoreVersion === verification.claims.scoreVersion &&
      latest.currentImageId === verification.claims.portraitId &&
      latestWaitMs > 0
    ) {
      throw tooFastError(latestWaitMs);
    }
    throw new ApiError(
      409,
      "ROUND_STALE",
      "That sandwich was already used or the round changed. Reload the current game state.",
      { retryable: true },
    );
  }

  return {
    ...(await buildGameState(updated, nowMs)),
    outcome,
  };
}

type ParsedPackReloadRequest =
  | { action: "start"; expectedScoreVersion: number }
  | { action: "complete"; reloadToken: string };

function parsePackReloadRequest(
  payload: Record<string, unknown>,
): ParsedPackReloadRequest {
  if (payload.action === "start") {
    assertOnlyKeys(payload, new Set(["action", "expectedScoreVersion"]));
    if (
      typeof payload.expectedScoreVersion !== "number" ||
      !Number.isSafeInteger(payload.expectedScoreVersion) ||
      payload.expectedScoreVersion < 0
    ) {
      throw new ApiError(
        400,
        "INVALID_SCORE_VERSION",
        "The expected score version must be a non-negative integer.",
      );
    }
    return {
      action: "start",
      expectedScoreVersion: payload.expectedScoreVersion,
    };
  }

  if (payload.action === "complete") {
    assertOnlyKeys(payload, new Set(["action", "reloadToken"]));
    if (
      typeof payload.reloadToken !== "string" ||
      payload.reloadToken.length === 0 ||
      payload.reloadToken.length > 1_024
    ) {
      throw new ApiError(
        400,
        "INVALID_RELOAD_TOKEN",
        "The reload token is invalid.",
      );
    }
    return { action: "complete", reloadToken: payload.reloadToken };
  }

  throw new ApiError(
    400,
    "INVALID_PACK_ACTION",
    "The pack action must be either start or complete.",
  );
}

function packStaleError(message: string): ApiError {
  return new ApiError(409, "PACK_STALE", message, { retryable: true });
}

function reloadTokenError(
  reason: "malformed" | "invalid-signature" | "expired",
): ApiError {
  if (reason === "expired") {
    return new ApiError(
      409,
      "RELOAD_EXPIRED",
      "That reload expired. Start a new reload and try again.",
      { retryable: true },
    );
  }
  return new ApiError(
    400,
    "INVALID_RELOAD_TOKEN",
    "The reload token is invalid.",
  );
}

function reloadAlreadyCompleted(
  player: PlayerRow,
  claims: PackReloadTokenClaims,
): boolean {
  return (
    player.scoreVersion === claims.scoreVersion + 1 &&
    player.packsOpened === claims.packsOpened + 1 &&
    player.currentPackId === claims.packId &&
    player.packTreatsRemaining > 0
  );
}

function reloadTooEarlyError(
  elapsedMs: number,
  pack: PackDefinition,
): ApiError {
  const nextAllowedAtMs = nextReloadOpportunityMs(elapsedMs, pack);
  return new ApiError(
    425,
    "RELOAD_TOO_EARLY",
    "The pack is still reloading.",
    {
      retryable: true,
      details: {
        retryAfterMs: Math.max(1, Math.ceil(nextAllowedAtMs - elapsedMs)),
      },
    },
  );
}

export async function openNextPack(
  request: Request,
  payload: Record<string, unknown>,
): Promise<PackReloadResponse> {
  const packRequest = parsePackReloadRequest(payload);
  const db = getDb();
  const session = await requireSessionPlayer(db, request);
  if (session.player.nickname === null) {
    throw new ApiError(
      409,
      "NICKNAME_REQUIRED",
      "Choose a nickname before opening your first pack.",
    );
  }

  if (packRequest.action === "start") {
    if (session.player.scoreVersion !== packRequest.expectedScoreVersion) {
      throw packStaleError(
        "That pack has already changed. Reload the game and try again.",
      );
    }
    if (session.player.packTreatsRemaining > 0) {
      throw new ApiError(
        409,
        "PACK_NOT_EMPTY",
        "Finish the current pack before opening another one.",
      );
    }

    const startedAtMs = Date.now();
    const targetPack = getPackForOrdinal(session.player.packsOpened + 1);
    const token = await signPackReloadToken(
      {
        kind: "pack-reload",
        playerId: session.player.id,
        scoreVersion: session.player.scoreVersion,
        packsOpened: session.player.packsOpened,
        packId: targetPack.id,
        catalogVersion: PACK_CATALOG_VERSION,
        startedAtMs,
        expiresAtMs: startedAtMs + PACK_RELOAD_TOKEN_TTL_MS,
      },
      getRoundTokenSecret(),
    );
    return {
      reload: {
        token,
        pack: targetPack,
        mechanic: targetPack.reload.id,
        durationMs: targetPack.reload.durationMs,
        windows: targetPack.reload.windows,
      },
    };
  }

  const nowMs = Date.now();
  const verification = await verifyPackReloadToken(
    packRequest.reloadToken,
    getRoundTokenSecret(),
    nowMs,
  );
  if (!verification.ok) {
    throw reloadTokenError(verification.reason);
  }
  const { claims } = verification;
  if (claims.playerId !== session.player.id) {
    throw new ApiError(
      400,
      "INVALID_RELOAD_TOKEN",
      "The reload token is invalid.",
    );
  }

  const targetPack = getPackForOrdinal(claims.packsOpened + 1);
  if (
    claims.catalogVersion !== PACK_CATALOG_VERSION ||
    claims.packId !== targetPack.id
  ) {
    throw packStaleError(
      "That box lineup changed before it could be opened. Start a new reload.",
    );
  }

  if (reloadAlreadyCompleted(session.player, claims)) {
    return buildGameState(session.player, nowMs);
  }
  if (
    session.player.scoreVersion !== claims.scoreVersion ||
    session.player.packsOpened !== claims.packsOpened
  ) {
    throw packStaleError(
      "That pack changed before it could be opened. Reload the game and try again.",
    );
  }
  if (session.player.packTreatsRemaining > 0) {
    throw new ApiError(
      409,
      "PACK_NOT_EMPTY",
      "Finish the current pack before opening another one.",
    );
  }

  const elapsedMs = nowMs - claims.startedAtMs;
  const timing = classifyPackReload(elapsedMs, targetPack);
  if (timing === "waiting") {
    throw reloadTooEarlyError(elapsedMs, targetPack);
  }
  const treats = targetPack.quantity;

  const [updated] = await db
    .update(players)
    .set({
      packsOpened: sql`${players.packsOpened} + 1`,
      packTreatsRemaining: treats,
      currentPackId: targetPack.id,
      scoreVersion: sql`${players.scoreVersion} + 1`,
      updatedAtMs: nowMs,
    })
    .where(
      and(
        eq(players.id, session.player.id),
        eq(players.sessionTokenHash, session.tokenHash),
        eq(players.packsOpened, claims.packsOpened),
        eq(players.scoreVersion, claims.scoreVersion),
        eq(players.packTreatsRemaining, 0),
      ),
    )
    .returning();

  if (updated) {
    return buildGameState(updated, nowMs);
  }

  const [latest] = await db
    .select()
    .from(players)
    .where(
      and(
        eq(players.id, session.player.id),
        eq(players.sessionTokenHash, session.tokenHash),
      ),
    )
    .limit(1);
  if (!latest) {
    throw new ApiError(401, "SESSION_REQUIRED", "The game session no longer exists.", {
      retryable: true,
    });
  }

  if (reloadAlreadyCompleted(latest, claims)) {
    return buildGameState(latest, nowMs);
  }

  throw packStaleError(
    "That pack changed before it could be opened. Reload the game and try again.",
  );
}

export async function getLeaderboard(): Promise<LeaderboardResponse> {
  const db = getDb();
  const [leaderRows, totalRows] = await Promise.all([
    db
      .select({
        nickname: players.nickname,
        publicTag: players.publicTag,
        sandwichesFed: players.sandwichesFed,
      })
      .from(players)
      .where(
        and(
          eq(players.leaderboardVisible, true),
          isNotNull(players.nickname),
        ),
      )
      .orderBy(
        desc(players.sandwichesFed),
        asc(sql`coalesce(${players.lastAcceptedAtMs}, ${players.createdAtMs})`),
        asc(players.id),
      )
      .limit(10),
    db
      .select({
        globalTotal: sql<number>`coalesce(sum(${players.sandwichesFed}), 0)`,
      })
      .from(players)
      .where(
        and(
          eq(players.leaderboardVisible, true),
          isNotNull(players.nickname),
        ),
      ),
  ]);

  const generatedAtMs = Date.now();
  return {
    leaders: leaderRows.map((row, index) => ({
      position: index + 1,
      displayName: displayName(row),
      publicTag: row.publicTag,
      sandwichesFed: row.sandwichesFed,
    })),
    globalTotal: Number(totalRows[0]?.globalTotal ?? 0),
    generatedAtMs,
    cachedUntilMs: generatedAtMs + 10_000,
  };
}

export async function deletePlayer(
  request: Request,
): Promise<DeletePlayerResponse> {
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!isSessionToken(token)) {
    return { ok: true };
  }

  const tokenHash = await hashSessionToken(token);
  const db = getDb();
  await db.delete(players).where(eq(players.sessionTokenHash, tokenHash));
  return { ok: true };
}
