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
import { ensureGameSchema, getDb } from "../../db";
import { players, type PlayerRow } from "../../db/schema";
import {
  PORTRAITS,
  PORTRAIT_BY_ID,
  type Portrait,
} from "../portraits";
import type {
  DeletePlayerResponse,
  FeedRequest,
  GameStateResponse,
  LeaderboardResponse,
  PlayerState,
  PortraitPreview,
  UpdatePlayerResponse,
} from "../game-types";
import { ApiError } from "./api-error";
import {
  claimsMatchRound,
  feedWaitMs,
  isNormalizedCoordinate,
  isPointInsideMouth,
  MIN_FEED_INTERVAL_MS,
  sandwichesRemainingInPack,
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
  signRoundToken,
  verifyRoundToken,
} from "./security";

const ROUND_TOKEN_TTL_MS = 5 * 60 * 1_000;
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
  return {
    nickname: player.nickname,
    publicTag: player.publicTag,
    displayName: displayName(player),
    sandwichesFed: player.sandwichesFed,
    sandwichesRemaining: sandwichesRemainingInPack(
      player.sandwichesFed,
      player.packsOpened,
    ),
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
    if (current.message.includes("UNIQUE constraint failed")) {
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
          packsOpened: 1,
          scoreVersion: 0,
          currentImageId: current.id,
          nextImageId: next.id,
          lastAcceptedAtMs: null,
          leaderboardVisible: true,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .returning();

      if (!player) {
        throw new Error("D1 did not return the newly created player.");
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
  await ensureGameSchema();
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

  await ensureGameSchema();
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
): Promise<GameStateResponse> {
  const feed = parseFeedRequest(payload);
  await ensureGameSchema();
  const db = getDb();
  const session = await requireSessionPlayer(db, request);
  if (session.player.nickname === null) {
    throw new ApiError(
      409,
      "NICKNAME_REQUIRED",
      "Choose a nickname before feeding your first sandwich.",
    );
  }
  if (
    sandwichesRemainingInPack(
      session.player.sandwichesFed,
      session.player.packsOpened,
    ) === 0
  ) {
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
  if (!isPointInsideMouth(feed.x, feed.y, portrait.mouth)) {
    throw new ApiError(422, "MISSED_MOUTH", "That click missed the mouth target.");
  }

  const nowMs = Date.now();
  const waitMs = feedWaitMs(session.player.lastAcceptedAtMs, nowMs);
  if (waitMs > 0) {
    throw tooFastError(waitMs);
  }

  const following = pickFollowingPortrait(session.player);
  const [updated] = await db
    .update(players)
    .set({
      sandwichesFed: sql`${players.sandwichesFed} + 1`,
      scoreVersion: sql`${players.scoreVersion} + 1`,
      currentImageId: session.player.nextImageId,
      nextImageId: following.id,
      lastAcceptedAtMs: nowMs,
      updatedAtMs: nowMs,
    })
    .where(
      and(
        eq(players.id, session.player.id),
        eq(players.sessionTokenHash, session.tokenHash),
        eq(players.scoreVersion, verification.claims.scoreVersion),
        eq(players.currentImageId, verification.claims.portraitId),
        sql`${players.sandwichesFed} < ${players.packsOpened} * ${SANDWICHES_PER_PACK}`,
        or(
          isNull(players.lastAcceptedAtMs),
          lte(players.lastAcceptedAtMs, nowMs - MIN_FEED_INTERVAL_MS),
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
    if (
      sandwichesRemainingInPack(latest.sandwichesFed, latest.packsOpened) === 0
    ) {
      throw new ApiError(
        409,
        "PACK_EMPTY",
        "Open a new FatBoy pack before feeding another sandwich.",
      );
    }
    const latestWaitMs = feedWaitMs(latest.lastAcceptedAtMs, Date.now());
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
      "That round was already scored or replaced. Reload the current game state.",
      { retryable: true },
    );
  }

  return buildGameState(updated, nowMs);
}

function parseOpenPackRequest(payload: Record<string, unknown>): number {
  assertOnlyKeys(payload, new Set(["expectedScoreVersion"]));
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
  return payload.expectedScoreVersion;
}

export async function openNextPack(
  request: Request,
  payload: Record<string, unknown>,
): Promise<GameStateResponse> {
  const expectedScoreVersion = parseOpenPackRequest(payload);
  await ensureGameSchema();
  const db = getDb();
  const session = await requireSessionPlayer(db, request);
  if (session.player.nickname === null) {
    throw new ApiError(
      409,
      "NICKNAME_REQUIRED",
      "Choose a nickname before opening your first pack.",
    );
  }

  const remaining = sandwichesRemainingInPack(
    session.player.sandwichesFed,
    session.player.packsOpened,
  );
  if (session.player.scoreVersion !== expectedScoreVersion) {
    if (
      session.player.scoreVersion === expectedScoreVersion + 1 &&
      remaining > 0
    ) {
      return buildGameState(session.player);
    }
    throw new ApiError(
      409,
      "PACK_STALE",
      "That pack has already changed. Reload the game and try again.",
      { retryable: true },
    );
  }
  if (remaining > 0) {
    throw new ApiError(
      409,
      "PACK_NOT_EMPTY",
      "Finish the current six-pack before opening another one.",
    );
  }

  const nowMs = Date.now();
  const [updated] = await db
    .update(players)
    .set({
      packsOpened: sql`${players.packsOpened} + 1`,
      scoreVersion: sql`${players.scoreVersion} + 1`,
      updatedAtMs: nowMs,
    })
    .where(
      and(
        eq(players.id, session.player.id),
        eq(players.sessionTokenHash, session.tokenHash),
        eq(players.packsOpened, session.player.packsOpened),
        eq(players.scoreVersion, expectedScoreVersion),
        sql`${players.sandwichesFed} = ${players.packsOpened} * ${SANDWICHES_PER_PACK}`,
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

  // Treat a concurrent pack-open request as success so a double click or a
  // second tab cannot open two packs or leave the UI in an error state.
  if (
    latest.scoreVersion === expectedScoreVersion + 1 &&
    sandwichesRemainingInPack(latest.sandwichesFed, latest.packsOpened) > 0
  ) {
    return buildGameState(latest, nowMs);
  }

  throw new ApiError(
    409,
    "PACK_STALE",
    "That pack changed before it could be opened. Reload the game and try again.",
    { retryable: true },
  );
}

export async function getLeaderboard(): Promise<LeaderboardResponse> {
  await ensureGameSchema();
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

  await ensureGameSchema();
  const tokenHash = await hashSessionToken(token);
  const db = getDb();
  await db.delete(players).where(eq(players.sessionTokenHash, tokenHash));
  return { ok: true };
}
