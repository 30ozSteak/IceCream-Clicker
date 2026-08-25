import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { errorResponse } from "../lib/server/api-error.ts";
import {
  ACTIVE_RELOAD_END_GRACE_MS,
  ACTIVE_RELOAD_END_MS,
  ACTIVE_RELOAD_START_MS,
  claimsMatchRound,
  classifyPackReload,
  feedWaitMs,
  isPointInsideMouth,
  PACK_RELOAD_DURATION_MS,
} from "../lib/server/game-rules.ts";
import { PACK_CATALOG_VERSION } from "../lib/packs.ts";
import {
  expiredSessionCookie,
  readCookie,
  sessionCookie,
} from "../lib/server/session-cookie.ts";
import { requireSameOrigin } from "../lib/server/http.ts";
import { validateNickname } from "../lib/server/nickname.ts";
import {
  createSessionToken,
  hashSessionToken,
  isSessionToken,
  signPackReloadToken,
  signRoundToken,
  verifyPackReloadToken,
  verifyRoundToken,
} from "../lib/server/security.ts";
import {
  ADD_CURRENT_PACK_ID_COLUMN_SQL,
  ADD_PACKS_OPENED_COLUMN_SQL,
  BACKFILL_PACKS_OPENED_SQL,
  BACKFILL_PACK_TREATS_REMAINING_SQL,
  REBUILD_PLAYERS_FOR_PACK_RELOAD_SQL,
  shouldBackfillPackTreatsDuringRebuild,
} from "../db/schema-maintenance.ts";

const TEST_SECRET = "test-round-secret-that-is-at-least-32-bytes-long";
const migrationsDirectory = new URL("../drizzle/", import.meta.url);
const migrations = readdirSync(migrationsDirectory)
  .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename))
  .sort()
  .map((filename) => ({
    filename,
    sql: readFileSync(new URL(filename, migrationsDirectory), "utf8").replaceAll(
      "--> statement-breakpoint",
      "",
    ),
  }));
const baseMigration = migrations[0].sql;
const packMigration = migrations[1].sql;

function packTreatsMigration() {
  const migration = migrations.find(({ filename }) => filename.startsWith("0002_"));
  assert.ok(migration, "Expected a 0002 pack-treat inventory migration.");
  return migration.sql;
}

function applyAllMigrations(database) {
  for (const migration of migrations) {
    database.exec(migration.sql);
  }
}

test("nickname validation normalizes supported names", () => {
  assert.deepEqual(validateNickname("  Ada    42  "), {
    ok: true,
    nickname: "Ada 42",
  });
  assert.deepEqual(validateNickname("Ａｄａ"), {
    ok: true,
    nickname: "Ada",
  });
});

test("nickname validation rejects invalid and impersonating names", () => {
  assert.equal(validateNickname("A").ok, false);
  assert.equal(validateNickname("Ada!").ok, false);
  assert.deepEqual(validateNickname("Fat Boy Official"), {
    ok: false,
    reason: "blocked",
  });
  assert.deepEqual(validateNickname("f u c k"), {
    ok: false,
    reason: "blocked",
  });
  for (const disguised of ["shitlord", "fuckyou2", "f u c k 2", "FаtBoy"]) {
    assert.deepEqual(validateNickname(disguised), {
      ok: false,
      reason: "blocked",
    });
  }
});

test("mouth hit testing uses the normalized server ellipse", () => {
  const mouth = { cx: 0.5, cy: 0.6, rx: 0.1, ry: 0.05 };
  assert.equal(isPointInsideMouth(0.5, 0.6, mouth), true);
  assert.equal(isPointInsideMouth(0.6, 0.6, mouth), true);
  assert.equal(isPointInsideMouth(0.601, 0.6, mouth), false);
  assert.equal(isPointInsideMouth(0.5, 0.651, mouth), false);
});

test("feed timing and round claims reject stale state", () => {
  assert.equal(feedWaitMs(null, 1_000), 0);
  assert.equal(feedWaitMs(900, 1_000), 100);
  assert.equal(feedWaitMs(800, 1_000), 0);
  assert.equal(
    claimsMatchRound(
      {
        playerId: "player-1",
        scoreVersion: 4,
        portraitId: "portrait-2",
        expiresAtMs: 2_000,
      },
      { id: "player-1", scoreVersion: 4, currentImageId: "portrait-2" },
    ),
    true,
  );
  assert.equal(
    claimsMatchRound(
      {
        playerId: "player-1",
        scoreVersion: 3,
        portraitId: "portrait-2",
        expiresAtMs: 2_000,
      },
      { id: "player-1", scoreVersion: 4, currentImageId: "portrait-2" },
    ),
    false,
  );
});

test("active reload timing classifies every boundary", () => {
  assert.ok(ACTIVE_RELOAD_START_MS > 0);
  assert.ok(ACTIVE_RELOAD_START_MS < ACTIVE_RELOAD_END_MS);
  assert.ok(
    ACTIVE_RELOAD_END_MS + ACTIVE_RELOAD_END_GRACE_MS <
      PACK_RELOAD_DURATION_MS,
  );

  assert.equal(classifyPackReload(0), "waiting");
  assert.equal(classifyPackReload(ACTIVE_RELOAD_START_MS - 1), "waiting");
  assert.equal(classifyPackReload(ACTIVE_RELOAD_START_MS), "perfect");
  assert.equal(classifyPackReload(ACTIVE_RELOAD_END_MS), "perfect");
  assert.equal(
    classifyPackReload(ACTIVE_RELOAD_END_MS + ACTIVE_RELOAD_END_GRACE_MS),
    "perfect",
  );
  assert.equal(
    classifyPackReload(ACTIVE_RELOAD_END_MS + ACTIVE_RELOAD_END_GRACE_MS + 1),
    "waiting",
  );
  assert.equal(classifyPackReload(PACK_RELOAD_DURATION_MS - 1), "waiting");
  assert.equal(classifyPackReload(PACK_RELOAD_DURATION_MS), "standard");
  assert.equal(classifyPackReload(PACK_RELOAD_DURATION_MS + 1), "standard");
  assert.throws(() => classifyPackReload(Number.NaN), /finite/u);
});

test("round tokens verify, expire, and fail after tampering", async () => {
  const claims = {
    playerId: "player-1",
    scoreVersion: 7,
    portraitId: "portrait-9",
    expiresAtMs: 10_000,
  };
  const token = await signRoundToken(claims, TEST_SECRET);

  assert.deepEqual(await verifyRoundToken(token, TEST_SECRET, 9_999), {
    ok: true,
    claims,
  });
  assert.deepEqual(await verifyRoundToken(token, TEST_SECRET, 10_000), {
    ok: false,
    reason: "expired",
  });

  const [payload, signature] = token.split(".");
  const replacement = signature[0] === "A" ? "B" : "A";
  const tampered = `${payload}.${replacement}${signature.slice(1)}`;
  assert.deepEqual(await verifyRoundToken(tampered, TEST_SECRET, 9_999), {
    ok: false,
    reason: "invalid-signature",
  });
});

test("pack reload tokens verify, expire, reject tampering, and are domain-bound", async () => {
  const claims = {
    kind: "pack-reload",
    playerId: "player-1",
    scoreVersion: 6,
    packsOpened: 1,
    packId: "vanilla-6",
    catalogVersion: PACK_CATALOG_VERSION,
    startedAtMs: 5_000,
    expiresAtMs: 10_000,
  };
  const token = await signPackReloadToken(claims, TEST_SECRET);

  assert.deepEqual(await verifyPackReloadToken(token, TEST_SECRET, 9_999), {
    ok: true,
    claims,
  });
  assert.deepEqual(await verifyPackReloadToken(token, TEST_SECRET, 10_000), {
    ok: false,
    reason: "expired",
  });

  const [payload, signature] = token.split(".");
  const replacement = signature[0] === "A" ? "B" : "A";
  const tampered = `${payload}.${replacement}${signature.slice(1)}`;
  assert.deepEqual(await verifyPackReloadToken(tampered, TEST_SECRET, 9_999), {
    ok: false,
    reason: "invalid-signature",
  });

  const roundToken = await signRoundToken(
    {
      playerId: claims.playerId,
      scoreVersion: claims.scoreVersion,
      portraitId: "portrait-1",
      expiresAtMs: claims.expiresAtMs,
    },
    TEST_SECRET,
  );
  assert.deepEqual(await verifyPackReloadToken(roundToken, TEST_SECRET, 9_999), {
    ok: false,
    reason: "invalid-signature",
  });
  assert.deepEqual(await verifyRoundToken(token, TEST_SECRET, 9_999), {
    ok: false,
    reason: "invalid-signature",
  });

  for (const requiredClaim of ["packId", "catalogVersion"]) {
    const incompleteClaims = { ...claims };
    delete incompleteClaims[requiredClaim];
    const incompleteToken = await signPackReloadToken(
      incompleteClaims,
      TEST_SECRET,
    );
    assert.deepEqual(
      await verifyPackReloadToken(incompleteToken, TEST_SECRET, 9_999),
      { ok: false, reason: "malformed" },
    );
  }
});

test("session tokens are 256-bit bearer values and only hashes are stable", async () => {
  const token = createSessionToken();
  assert.equal(isSessionToken(token), true);
  assert.equal(token.length, 43);
  const firstHash = await hashSessionToken(token);
  const secondHash = await hashSessionToken(token);
  assert.equal(firstHash, secondHash);
  assert.notEqual(firstHash, token);
});

test("session cookie attributes are secure and deletion mirrors the path", () => {
  const token = "A".repeat(43);
  const created = sessionCookie(token);
  assert.equal(readCookie(`theme=blue; fb_session=${token}`, "fb_session"), token);
  assert.match(created, /Max-Age=31536000/u);
  assert.match(created, /HttpOnly/u);
  assert.match(created, /Secure/u);
  assert.match(created, /SameSite=Lax/u);
  assert.match(created, /Path=\//u);
  assert.match(expiredSessionCookie(), /Max-Age=0/u);
});

test("same-origin checks honor a valid Host alias and reject foreign origins", () => {
  const localRequest = new Request("http://localhost:3100/api/player", {
    headers: {
      Host: "127.0.0.1:3100",
      Origin: "http://127.0.0.1:3100",
    },
  });
  assert.doesNotThrow(() => requireSameOrigin(localRequest));

  const foreignRequest = new Request("http://localhost:3100/api/player", {
    headers: {
      Host: "127.0.0.1:3100",
      Origin: "https://attacker.example",
    },
  });
  assert.throws(
    () => requireSameOrigin(foreignRequest),
    /Cross-origin game requests are not allowed/u,
  );
});

test("database error logs redact Postgres credentials without losing classification", async () => {
  const databaseUrl =
    "postgresql://audit-user:do-not-log-this@bad%host/game?sslmode=require";
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const originalConsoleError = console.error;
  const logged = [];
  process.env.DATABASE_URL = databaseUrl;
  console.error = (...values) => {
    logged.push(values.map(String).join(" "));
  };

  try {
    const postgresError = Object.assign(
      new Error(`relation "players" does not exist. Connection string: ${databaseUrl}`),
      { code: "42P01" },
    );
    const wrappedError = new Error("Failed to load the game database", {
      cause: postgresError,
    });
    const response = errorResponse(
      wrappedError,
      new Request("https://fatboy.example/api/game"),
    );

    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "DATABASE_NOT_READY");
  } finally {
    console.error = originalConsoleError;
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }

  const output = logged.join("\n");
  assert.match(output, /Failed to load the game database/u);
  assert.match(output, /\[REDACTED_DATABASE_URL\]/u);
  assert.doesNotMatch(output, /audit-user|do-not-log-this|postgresql:\/\//u);
});

test("migration is idempotent and leaderboard uses score-reached time", () => {
  const database = new DatabaseSync(":memory:");

  database.exec(baseMigration);
  database.exec(baseMigration);
  database.exec(packMigration);
  database.exec(packTreatsMigration());
  const insert = database.prepare(`
    INSERT INTO players (
      id, session_token_hash, nickname, public_tag, sandwiches_fed,
      sandwiches_thrown, packs_opened, pack_treats_remaining, score_version,
      current_image_id, next_image_id, last_accepted_at_ms, last_throw_at_ms,
      leaderboard_visible, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("a", "hash-a", "Alpha", "AAAA", 5, 5, 1, 1, 5, "1", "2", 300, 300, 1, 100, 300);
  insert.run("b", "hash-b", "Bravo", "BBBB", 5, 5, 1, 1, 5, "1", "2", 200, 200, 1, 50, 200);
  insert.run("c", "hash-c", "Charlie", "CCCC", 5, 5, 1, 1, 5, "1", "2", null, null, 1, 150, 150);
  insert.run("d", "hash-d", "Hidden", "DDDD", 999, 999, 167, 3, 9, "1", "2", 10, 10, 0, 10, 10);
  insert.run("e", "hash-e", "Echo", "EEEE", 6, 6, 1, 0, 6, "1", "2", 400, 400, 1, 400, 400);
  for (const id of ["f", "g", "h", "i", "j", "k", "l", "m"]) {
    insert.run(
      id,
      `hash-${id}`,
      `Player ${id}`,
      id.toUpperCase().repeat(4),
      4,
      4,
      1,
      2,
      4,
      "1",
      "2",
      500,
      500,
      1,
      500,
      500,
    );
  }
  insert.run("n", "hash-n", null, "NNNN", 50, 50, 9, 4, 50, "1", "2", 600, 600, 1, 600, 600);

  database.exec("UPDATE players SET nickname = 'Renamed', updated_at_ms = 9999 WHERE id = 'c'");
  const leaders = database
    .prepare(`
      SELECT id FROM players
      WHERE leaderboard_visible = 1 AND nickname IS NOT NULL
      ORDER BY sandwiches_fed DESC,
        coalesce(last_accepted_at_ms, created_at_ms) ASC,
        id ASC
      LIMIT 10
    `)
    .all()
    .map((row) => row.id);
  const total = database
    .prepare(
      "SELECT coalesce(sum(sandwiches_fed), 0) AS total FROM players WHERE leaderboard_visible = 1 AND nickname IS NOT NULL",
    )
    .get().total;

  assert.deepEqual(leaders, ["e", "c", "b", "a", "f", "g", "h", "i", "j", "k"]);
  assert.equal(total, 53);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("atomic throws spend a twelve-treat pack, score only hits, and reject replay", () => {
  const database = new DatabaseSync(":memory:");
  applyAllMigrations(database);
  database
    .prepare(`
      INSERT INTO players (
        id, session_token_hash, nickname, public_tag, sandwiches_fed,
        sandwiches_thrown, packs_opened, pack_treats_remaining, score_version,
        current_image_id, next_image_id, last_accepted_at_ms, last_throw_at_ms,
        leaderboard_visible, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 0, 0, 4, 12, 0, ?, ?, null, null, 1, 0, 0)
    `)
    .run("player", "session-hash", "Tester", "TEST", "portrait-a", "portrait-b");

  const atomicHit = database.prepare(`
    UPDATE players SET
      sandwiches_fed = sandwiches_fed + 1,
      sandwiches_thrown = sandwiches_thrown + 1,
      pack_treats_remaining = pack_treats_remaining - 1,
      score_version = score_version + 1,
      current_image_id = ?,
      next_image_id = ?,
      last_accepted_at_ms = ?,
      last_throw_at_ms = ?,
      updated_at_ms = ?
    WHERE id = ?
      AND session_token_hash = ?
      AND score_version = ?
      AND current_image_id = ?
      AND pack_treats_remaining > 0
      AND (last_throw_at_ms IS NULL OR last_throw_at_ms <= ?)
    RETURNING sandwiches_fed, sandwiches_thrown, pack_treats_remaining,
      score_version, current_image_id, last_accepted_at_ms, last_throw_at_ms
  `);
  const atomicMiss = database.prepare(`
    UPDATE players SET
      sandwiches_thrown = sandwiches_thrown + 1,
      pack_treats_remaining = pack_treats_remaining - 1,
      score_version = score_version + 1,
      last_throw_at_ms = ?,
      updated_at_ms = ?
    WHERE id = ?
      AND session_token_hash = ?
      AND score_version = ?
      AND current_image_id = ?
      AND pack_treats_remaining > 0
      AND (last_throw_at_ms IS NULL OR last_throw_at_ms <= ?)
    RETURNING sandwiches_fed, sandwiches_thrown, pack_treats_remaining,
      score_version, current_image_id, last_accepted_at_ms, last_throw_at_ms
  `);

  const first = atomicHit.get(
    "portrait-b",
    "portrait-c",
    1_000,
    1_000,
    1_000,
    "player",
    "session-hash",
    0,
    "portrait-a",
    800,
  );
  assert.deepEqual({ ...first }, {
    sandwiches_fed: 1,
    sandwiches_thrown: 1,
    pack_treats_remaining: 11,
    score_version: 1,
    current_image_id: "portrait-b",
    last_accepted_at_ms: 1_000,
    last_throw_at_ms: 1_000,
  });

  const replay = atomicHit.get(
    "portrait-b",
    "portrait-c",
    1_000,
    1_000,
    1_000,
    "player",
    "session-hash",
    0,
    "portrait-a",
    800,
  );
  assert.equal(replay, undefined);

  const tooFast = atomicMiss.get(
    1_100,
    1_100,
    "player",
    "session-hash",
    1,
    "portrait-b",
    900,
  );
  assert.equal(tooFast, undefined);

  const missAtBoundary = atomicMiss.get(
    1_200,
    1_200,
    "player",
    "session-hash",
    1,
    "portrait-b",
    1_000,
  );
  assert.deepEqual({ ...missAtBoundary }, {
    sandwiches_fed: 1,
    sandwiches_thrown: 2,
    pack_treats_remaining: 10,
    score_version: 2,
    current_image_id: "portrait-b",
    last_accepted_at_ms: 1_000,
    last_throw_at_ms: 1_200,
  });

  const portraits = [
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
  ];
  let currentPortrait = "portrait-b";
  for (let index = 0; index < 10; index += 1) {
    const nowMs = 1_400 + index * 200;
    const nextPortrait = `portrait-${portraits[index]}`;
    const followingPortrait = `portrait-${portraits[index + 1]}`;
    const accepted = atomicHit.get(
      nextPortrait,
      followingPortrait,
      nowMs,
      nowMs,
      nowMs,
      "player",
      "session-hash",
      2 + index,
      currentPortrait,
      nowMs - 200,
    );
    assert.deepEqual(
      {
        sandwiches_fed: accepted.sandwiches_fed,
        sandwiches_thrown: accepted.sandwiches_thrown,
        pack_treats_remaining: accepted.pack_treats_remaining,
        score_version: accepted.score_version,
      },
      {
        sandwiches_fed: 2 + index,
        sandwiches_thrown: 3 + index,
        pack_treats_remaining: 9 - index,
        score_version: 3 + index,
      },
    );
    currentPortrait = nextPortrait;
  }

  assert.equal(
    atomicMiss.get(
      3_400,
      3_400,
      "player",
      "session-hash",
      12,
      currentPortrait,
      3_200,
    ),
    undefined,
  );
  database.close();
});

test("progression pack inventory writes are atomic and capped at twelve", () => {
  const database = new DatabaseSync(":memory:");
  applyAllMigrations(database);
  database
    .prepare(`
      INSERT INTO players (
        id, session_token_hash, nickname, public_tag, sandwiches_fed,
        sandwiches_thrown, packs_opened, pack_treats_remaining, score_version,
        current_image_id, next_image_id, last_accepted_at_ms, last_throw_at_ms,
        leaderboard_visible, created_at_ms, updated_at_ms
      ) VALUES ('player', 'session-hash', 'Tester', 'PACK', 18, 18, 3, 0, 20,
        'portrait-a', 'portrait-b', 1000, 1200, 1, 0, 1200)
    `)
    .run();

  const openPack = database.prepare(`
    UPDATE players SET
      pack_treats_remaining = ?,
      packs_opened = packs_opened + 1,
      score_version = score_version + 1,
      updated_at_ms = updated_at_ms + 1
    WHERE id = 'player'
      AND score_version = ?
      AND pack_treats_remaining = 0
    RETURNING packs_opened, pack_treats_remaining, score_version
  `);

  assert.deepEqual({ ...openPack.get(12, 20) }, {
    packs_opened: 4,
    pack_treats_remaining: 12,
    score_version: 21,
  });
  assert.equal(openPack.get(6, 20), undefined);

  database.exec(
    `UPDATE players SET
      sandwiches_fed = 30,
      sandwiches_thrown = 30,
      pack_treats_remaining = 0,
      score_version = 33
    WHERE id = 'player'`,
  );
  assert.throws(() => openPack.get(13, 33), /CHECK constraint failed/u);
  assert.deepEqual({ ...openPack.get(6, 33) }, {
    packs_opened: 5,
    pack_treats_remaining: 6,
    score_version: 34,
  });
  assert.equal(openPack.get(4, 33), undefined);
  database.close();
});

test("0002 backfills legacy inventory and 0003 raises its capacity to twelve", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(baseMigration);
  const insert = database.prepare(`
    INSERT INTO players (
      id, session_token_hash, nickname, public_tag, sandwiches_fed,
      score_version, current_image_id, next_image_id, last_accepted_at_ms,
      leaderboard_visible, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'Legacy', ?, ?, ?, 'a', 'b', null, 1, 0, 0)
  `);
  const scores = [0, 1, 5, 6, 7, 12];
  scores.forEach((score, index) => {
    const suffix = String(index).padStart(4, "0");
    insert.run(`player-${index}`, `hash-${index}`, suffix, score, score);
  });

  database.exec(packMigration);
  database.exec(packTreatsMigration());
  assert.deepEqual(
    database
      .prepare(`
        SELECT sandwiches_fed, sandwiches_thrown, packs_opened,
          pack_treats_remaining, last_throw_at_ms
        FROM players ORDER BY sandwiches_fed
      `)
      .all()
      .map((row) => ({ ...row })),
    [
      {
        sandwiches_fed: 0,
        sandwiches_thrown: 0,
        packs_opened: 1,
        pack_treats_remaining: 6,
        last_throw_at_ms: null,
      },
      {
        sandwiches_fed: 1,
        sandwiches_thrown: 1,
        packs_opened: 1,
        pack_treats_remaining: 5,
        last_throw_at_ms: null,
      },
      {
        sandwiches_fed: 5,
        sandwiches_thrown: 5,
        packs_opened: 1,
        pack_treats_remaining: 1,
        last_throw_at_ms: null,
      },
      {
        sandwiches_fed: 6,
        sandwiches_thrown: 6,
        packs_opened: 1,
        pack_treats_remaining: 0,
        last_throw_at_ms: null,
      },
      {
        sandwiches_fed: 7,
        sandwiches_thrown: 7,
        packs_opened: 2,
        pack_treats_remaining: 5,
        last_throw_at_ms: null,
      },
      {
        sandwiches_fed: 12,
        sandwiches_thrown: 12,
        packs_opened: 2,
        pack_treats_remaining: 0,
        last_throw_at_ms: null,
      },
    ],
  );
  const capacityMigration = migrations.find(({ filename }) =>
    filename.startsWith("0003_"),
  );
  assert.ok(
    capacityMigration,
    "Expected a 0003 twelve-treat capacity migration.",
  );
  database.exec(capacityMigration.sql);
  database.exec(
    "UPDATE players SET pack_treats_remaining = 12 WHERE id = 'player-0'",
  );
  assert.equal(
    database
      .prepare("SELECT pack_treats_remaining FROM players WHERE id = 'player-0'")
      .get().pack_treats_remaining,
    12,
  );
  assert.throws(
    () =>
      database.exec(
        "UPDATE players SET pack_treats_remaining = 13 WHERE id = 'player-0'",
      ),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () =>
      database.exec(
        "UPDATE players SET pack_treats_remaining = -1 WHERE id = 'player-0'",
      ),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () =>
      database.exec(
        `UPDATE players SET sandwiches_fed = 1, sandwiches_thrown = 0
        WHERE id = 'player-0'`,
      ),
    /CHECK constraint failed/u,
  );
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("a late pack migration preserves a pack opened by runtime bootstrap", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(baseMigration);
  database.exec(packMigration);
  database
    .prepare(`
      INSERT INTO players (
        id, session_token_hash, nickname, public_tag, sandwiches_fed,
        packs_opened, score_version, current_image_id, next_image_id,
        last_accepted_at_ms, leaderboard_visible, created_at_ms, updated_at_ms
      ) VALUES ('runtime-player', 'runtime-hash', 'Runtime', 'BOOT', 6, 2, 7,
        'a', 'b', 1000, 1, 0, 1000)
    `)
    .run();

  database.exec(packMigration);
  database.exec(packTreatsMigration());
  assert.deepEqual(
    {
      ...database
        .prepare(`
          SELECT sandwiches_fed, sandwiches_thrown, packs_opened,
            pack_treats_remaining, score_version
          FROM players WHERE id = 'runtime-player'
        `)
        .get(),
    },
    {
      sandwiches_fed: 6,
      sandwiches_thrown: 6,
      packs_opened: 2,
      pack_treats_remaining: 6,
      score_version: 7,
    },
  );
  database.close();
});

test("a late capacity migration reconstructs progressed pack identity", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(baseMigration);
  database.exec(packMigration);
  database.exec(packTreatsMigration());
  database.exec(ADD_CURRENT_PACK_ID_COLUMN_SQL);
  database.exec(`
    INSERT INTO players (
      id, session_token_hash, nickname, public_tag, sandwiches_fed,
      sandwiches_thrown, packs_opened, pack_treats_remaining, current_pack_id,
      score_version, current_image_id, next_image_id, last_accepted_at_ms,
      last_throw_at_ms, leaderboard_visible, created_at_ms, updated_at_ms
    ) VALUES ('progressed-player', 'progressed-hash', 'Progressed', 'CYCL',
      36, 36, 7, 5, 'sugar-cookie-6', 43, 'a', 'b', 1000, 1000, 1, 0, 1000)
  `);

  const capacityMigration = migrations.find(({ filename }) =>
    filename.startsWith("0003_"),
  );
  assert.ok(capacityMigration, "Expected a 0003 capacity migration.");
  database.exec(capacityMigration.sql);

  assert.deepEqual(
    {
      ...database
        .prepare(`
          SELECT packs_opened, pack_treats_remaining, current_pack_id
          FROM players WHERE id = 'progressed-player'
        `)
        .get(),
    },
    {
      packs_opened: 7,
      pack_treats_remaining: 5,
      current_pack_id: "sugar-cookie-6",
    },
  );
  database.close();
});

test("runtime capacity upgrade preserves legacy bonus inventory and pack identity", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(baseMigration);
  database.exec(packMigration);
  database.exec(packTreatsMigration());
  database.exec(ADD_CURRENT_PACK_ID_COLUMN_SQL);
  database.exec(`
    INSERT INTO players (
      id, session_token_hash, nickname, public_tag, sandwiches_fed,
      sandwiches_thrown, packs_opened, pack_treats_remaining, current_pack_id,
      score_version,
      current_image_id, next_image_id, last_accepted_at_ms, last_throw_at_ms,
      leaderboard_visible, created_at_ms, updated_at_ms
    ) VALUES
      ('spent-bonus', 'hash-spent', 'Spent Bonus', 'SPNT', 13, 13, 2, 0,
        'vanilla-6', 14,
        'a', 'b', 1000, 1000, 1, 0, 1000),
      ('active-bonus', 'hash-active', 'Active Bonus', 'ACTV', 36, 36, 7, 5,
        'sugar-cookie-6', 43,
        'a', 'b', 1000, 1000, 1, 0, 1000)
  `);

  const definition = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'players'",
    )
    .get().sql;
  const shouldBackfill = shouldBackfillPackTreatsDuringRebuild(
    definition,
    false,
  );
  assert.equal(shouldBackfill, false);
  if (shouldBackfill) {
    database.exec(BACKFILL_PACK_TREATS_REMAINING_SQL);
  }
  for (const statement of REBUILD_PLAYERS_FOR_PACK_RELOAD_SQL) {
    database.exec(statement);
  }

  assert.deepEqual(
    database
      .prepare(`
        SELECT id, pack_treats_remaining, current_pack_id
        FROM players ORDER BY id
      `)
      .all()
      .map((row) => ({ ...row })),
    [
      {
        id: "active-bonus",
        pack_treats_remaining: 5,
        current_pack_id: "sugar-cookie-6",
      },
      {
        id: "spent-bonus",
        pack_treats_remaining: 0,
        current_pack_id: "vanilla-6",
      },
    ],
  );
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("runtime schema maintenance upgrades the live legacy table in place", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(baseMigration);
  database.exec(`
    INSERT INTO players (
      id, session_token_hash, nickname, public_tag, sandwiches_fed,
      score_version, current_image_id, next_image_id, last_accepted_at_ms,
      leaderboard_visible, created_at_ms, updated_at_ms
    ) VALUES
      ('legacy-56', 'hash-56', 'Existing Player', 'LIVE', 56, 56, 'a', 'b', 1, 1, 0, 1),
      ('empty-6', 'hash-6', 'Empty Pack', 'EMTY', 6, 6, 'a', 'b', 1, 1, 0, 1),
      ('opened-6', 'hash-7', 'Opened Pack', 'OPEN', 6, 7, 'a', 'b', 1, 1, 0, 1)
  `);

  database.exec(ADD_PACKS_OPENED_COLUMN_SQL);
  database.exec(BACKFILL_PACKS_OPENED_SQL);
  database.exec(BACKFILL_PACKS_OPENED_SQL);

  assert.deepEqual(
    database
      .prepare("SELECT id, packs_opened FROM players ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: "empty-6", packs_opened: 1 },
      { id: "legacy-56", packs_opened: 10 },
      { id: "opened-6", packs_opened: 2 },
    ],
  );
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("hashed browser sessions restore, rename, and delete without score loss", async () => {
  const database = new DatabaseSync(":memory:");
  applyAllMigrations(database);
  const token = createSessionToken();
  const tokenHash = await hashSessionToken(token);
  database
    .prepare(`
      INSERT INTO players (
        id, session_token_hash, nickname, public_tag, sandwiches_fed,
        sandwiches_thrown, packs_opened, pack_treats_remaining, score_version,
        current_image_id, next_image_id, last_accepted_at_ms, last_throw_at_ms,
        leaderboard_visible, created_at_ms, updated_at_ms
      ) VALUES (
        'player', ?, 'First Name', 'ABCD', 7, 7, 2, 5, 7,
        'a', 'b', 700, 700, 1, 0, 700
      )
    `)
    .run(tokenHash);

  assert.equal(
    database
      .prepare("SELECT id FROM players WHERE session_token_hash = ?")
      .get(await hashSessionToken(token)).id,
    "player",
  );
  database
    .prepare("UPDATE players SET nickname = ?, updated_at_ms = ? WHERE id = ?")
    .run("Second Name", 900, "player");
  assert.deepEqual(
    {
      ...database
        .prepare("SELECT nickname, public_tag, sandwiches_fed FROM players WHERE id = 'player'")
        .get(),
    },
    { nickname: "Second Name", public_tag: "ABCD", sandwiches_fed: 7 },
  );
  database.prepare("DELETE FROM players WHERE session_token_hash = ?").run(tokenHash);
  assert.equal(
    database.prepare("SELECT id FROM players WHERE id = 'player'").get(),
    undefined,
  );
  database.close();
});
