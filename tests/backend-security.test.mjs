import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  claimsMatchRound,
  feedWaitMs,
  isPointInsideMouth,
  sandwichesRemainingInPack,
  SANDWICHES_PER_PACK,
} from "../lib/server/game-rules.ts";
import {
  expiredSessionCookie,
  readCookie,
  sessionCookie,
} from "../lib/server/session-cookie.ts";
import { validateNickname } from "../lib/server/nickname.ts";
import {
  createSessionToken,
  hashSessionToken,
  isSessionToken,
  signRoundToken,
  verifyRoundToken,
} from "../lib/server/security.ts";

const TEST_SECRET = "test-round-secret-that-is-at-least-32-bytes-long";
const baseMigration = readFileSync(
  new URL("../drizzle/0000_volatile_mongu.sql", import.meta.url),
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const packMigration = readFileSync(
  new URL("../drizzle/0001_cool_wendell_vaughn.sql", import.meta.url),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

function applyAllMigrations(database) {
  database.exec(baseMigration);
  database.exec(packMigration);
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

test("six sandwiches exhaust a pack and invalid pack windows fail closed", () => {
  assert.equal(SANDWICHES_PER_PACK, 6);
  assert.equal(sandwichesRemainingInPack(0, 1), 6);
  assert.equal(sandwichesRemainingInPack(5, 1), 1);
  assert.equal(sandwichesRemainingInPack(6, 1), 0);
  assert.equal(sandwichesRemainingInPack(6, 2), 6);
  assert.equal(sandwichesRemainingInPack(11, 2), 1);
  assert.equal(sandwichesRemainingInPack(12, 2), 0);
  assert.throws(() => sandwichesRemainingInPack(7, 1), /outside the active pack/u);
  assert.throws(() => sandwichesRemainingInPack(0, 0), /invalid/u);
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

test("migration is idempotent and leaderboard uses score-reached time", () => {
  const database = new DatabaseSync(":memory:");

  database.exec(baseMigration);
  database.exec(baseMigration);
  database.exec(packMigration);
  const insert = database.prepare(`
    INSERT INTO players (
      id, session_token_hash, nickname, public_tag, sandwiches_fed,
      packs_opened, score_version, current_image_id, next_image_id,
      last_accepted_at_ms, leaderboard_visible, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("a", "hash-a", "Alpha", "AAAA", 5, 1, 5, "1", "2", 300, 1, 100, 300);
  insert.run("b", "hash-b", "Bravo", "BBBB", 5, 1, 5, "1", "2", 200, 1, 50, 200);
  insert.run("c", "hash-c", "Charlie", "CCCC", 5, 1, 5, "1", "2", null, 1, 150, 150);
  insert.run("d", "hash-d", "Hidden", "DDDD", 999, 167, 9, "1", "2", 10, 0, 10, 10);
  insert.run("e", "hash-e", "Echo", "EEEE", 6, 1, 6, "1", "2", 400, 1, 400, 400);
  for (const id of ["f", "g", "h", "i", "j", "k", "l", "m"]) {
    insert.run(
      id,
      `hash-${id}`,
      `Player ${id}`,
      id.toUpperCase().repeat(4),
      4,
      1,
      4,
      "1",
      "2",
      500,
      1,
      500,
      500,
    );
  }
  insert.run("n", "hash-n", null, "NNNN", 50, 9, 50, "1", "2", 600, 1, 600, 600);

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

test("the atomic feed transition rejects replay and enforces 200ms", () => {
  const database = new DatabaseSync(":memory:");
  applyAllMigrations(database);
  database
    .prepare(`
      INSERT INTO players (
        id, session_token_hash, nickname, public_tag, sandwiches_fed,
        score_version, current_image_id, next_image_id, last_accepted_at_ms,
        leaderboard_visible, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, null, 1, 0, 0)
    `)
    .run("player", "session-hash", "Tester", "TEST", "portrait-a", "portrait-b");

  const atomicFeed = database.prepare(`
    UPDATE players SET
      sandwiches_fed = sandwiches_fed + 1,
      score_version = score_version + 1,
      current_image_id = ?,
      next_image_id = ?,
      last_accepted_at_ms = ?,
      updated_at_ms = ?
    WHERE id = ?
      AND session_token_hash = ?
      AND score_version = ?
      AND current_image_id = ?
      AND sandwiches_fed < packs_opened * 6
      AND (last_accepted_at_ms IS NULL OR last_accepted_at_ms <= ?)
    RETURNING sandwiches_fed, score_version, current_image_id
  `);

  const first = atomicFeed.get(
    "portrait-b",
    "portrait-c",
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
    score_version: 1,
    current_image_id: "portrait-b",
  });

  const replay = atomicFeed.get(
    "portrait-b",
    "portrait-c",
    1_000,
    1_000,
    "player",
    "session-hash",
    0,
    "portrait-a",
    800,
  );
  assert.equal(replay, undefined);

  const tooFast = atomicFeed.get(
    "portrait-c",
    "portrait-d",
    1_100,
    1_100,
    "player",
    "session-hash",
    1,
    "portrait-b",
    900,
  );
  assert.equal(tooFast, undefined);

  const atBoundary = atomicFeed.get(
    "portrait-c",
    "portrait-d",
    1_200,
    1_200,
    "player",
    "session-hash",
    1,
    "portrait-b",
    1_000,
  );
  assert.deepEqual({ ...atBoundary }, {
    sandwiches_fed: 2,
    score_version: 2,
    current_image_id: "portrait-c",
  });
  database.close();
});

test("pack opening is atomic, versioned, and cannot be replayed later", () => {
  const database = new DatabaseSync(":memory:");
  applyAllMigrations(database);
  database
    .prepare(`
      INSERT INTO players (
        id, session_token_hash, nickname, public_tag, sandwiches_fed,
        packs_opened, score_version, current_image_id, next_image_id,
        last_accepted_at_ms, leaderboard_visible, created_at_ms, updated_at_ms
      ) VALUES ('player', 'session-hash', 'Tester', 'PACK', 6, 1, 6,
        'portrait-a', 'portrait-b', 1000, 1, 0, 1000)
    `)
    .run();

  const openPack = database.prepare(`
    UPDATE players SET
      packs_opened = packs_opened + 1,
      score_version = score_version + 1,
      updated_at_ms = updated_at_ms + 1
    WHERE id = 'player'
      AND score_version = ?
      AND sandwiches_fed = packs_opened * 6
    RETURNING packs_opened, score_version
  `);

  assert.deepEqual({ ...openPack.get(6) }, { packs_opened: 2, score_version: 7 });
  assert.equal(openPack.get(6), undefined);

  database.exec(
    "UPDATE players SET sandwiches_fed = 12, score_version = 13 WHERE id = 'player'",
  );
  assert.equal(openPack.get(6), undefined);
  assert.deepEqual({ ...openPack.get(13) }, { packs_opened: 3, score_version: 14 });
  database.close();
});

test("legacy scores backfill into the correct active six-pack", () => {
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
  assert.deepEqual(
    database
      .prepare("SELECT sandwiches_fed, packs_opened FROM players ORDER BY sandwiches_fed")
      .all()
      .map((row) => ({ ...row })),
    [
      { sandwiches_fed: 0, packs_opened: 1 },
      { sandwiches_fed: 1, packs_opened: 1 },
      { sandwiches_fed: 5, packs_opened: 1 },
      { sandwiches_fed: 6, packs_opened: 1 },
      { sandwiches_fed: 7, packs_opened: 2 },
      { sandwiches_fed: 12, packs_opened: 2 },
    ],
  );
  database.close();
});

test("a late pack migration preserves a pack opened by runtime bootstrap", () => {
  const database = new DatabaseSync(":memory:");
  applyAllMigrations(database);
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
  assert.deepEqual(
    {
      ...database
        .prepare(`
          SELECT sandwiches_fed, packs_opened, score_version
          FROM players WHERE id = 'runtime-player'
        `)
        .get(),
    },
    { sandwiches_fed: 6, packs_opened: 2, score_version: 7 },
  );
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
        packs_opened, score_version, current_image_id, next_image_id,
        last_accepted_at_ms, leaderboard_visible, created_at_ms, updated_at_ms
      ) VALUES ('player', ?, 'First Name', 'ABCD', 7, 2, 7, 'a', 'b', 700, 1, 0, 700)
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
