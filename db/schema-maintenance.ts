export const ADD_PACKS_OPENED_COLUMN_SQL = `ALTER TABLE players
  ADD COLUMN packs_opened INTEGER NOT NULL DEFAULT 1
  CHECK (packs_opened >= 1)`;

// Legacy scores can land exactly on a six-pack boundary, where score alone
// cannot distinguish an empty pack from one that was just opened. score_version
// includes each successful pack open, so the bounded expression preserves that
// state while also safely backfilling databases created before packs existed.
export const BACKFILL_PACKS_OPENED_SQL = `UPDATE players
  SET packs_opened = min(
    (sandwiches_fed / 6) + 1,
    max(
      CASE
        WHEN sandwiches_fed = 0 THEN 1
        ELSE ((sandwiches_fed - 1) / 6) + 1
      END,
      1 + max(0, score_version - sandwiches_fed)
    )
  )`;

export const ADD_SANDWICHES_THROWN_COLUMN_SQL = `ALTER TABLE players
  ADD COLUMN sandwiches_thrown INTEGER NOT NULL DEFAULT 0
  CHECK (sandwiches_thrown >= 0)`;

export const BACKFILL_SANDWICHES_THROWN_SQL = `UPDATE players
  SET sandwiches_thrown = sandwiches_fed`;

export const ADD_LAST_THROW_AT_COLUMN_SQL = `ALTER TABLE players
  ADD COLUMN last_throw_at_ms INTEGER`;

export const BACKFILL_LAST_THROW_AT_SQL = `UPDATE players
  SET last_throw_at_ms = last_accepted_at_ms`;

export const ADD_PACK_TREATS_REMAINING_COLUMN_SQL = `ALTER TABLE players
  ADD COLUMN pack_treats_remaining INTEGER NOT NULL DEFAULT 6
  CHECK (pack_treats_remaining BETWEEN 0 AND 7)`;

export const BACKFILL_PACK_TREATS_REMAINING_SQL = `UPDATE players
  SET pack_treats_remaining = packs_opened * 6 - sandwiches_thrown`;

// SQLite cannot drop the legacy active-pack CHECK in place. Runtime bootstrap
// rebuilds the table after adding/backfilling the gameplay columns so active
// reload packs can safely hold seven treats while preserving existing scores.
export const REBUILD_PLAYERS_FOR_PACK_RELOAD_SQL = [
  `DROP TABLE IF EXISTS __players_pack_reload`,
  `CREATE TABLE __players_pack_reload (
    id TEXT PRIMARY KEY NOT NULL,
    session_token_hash TEXT NOT NULL,
    nickname TEXT,
    public_tag TEXT NOT NULL,
    sandwiches_fed INTEGER NOT NULL DEFAULT 0 CHECK (sandwiches_fed >= 0),
    sandwiches_thrown INTEGER NOT NULL DEFAULT 0 CHECK (sandwiches_thrown >= 0),
    packs_opened INTEGER NOT NULL DEFAULT 1 CHECK (packs_opened >= 1),
    pack_treats_remaining INTEGER NOT NULL DEFAULT 6
      CHECK (pack_treats_remaining BETWEEN 0 AND 7),
    score_version INTEGER NOT NULL DEFAULT 0 CHECK (score_version >= 0),
    current_image_id TEXT NOT NULL,
    next_image_id TEXT NOT NULL,
    last_accepted_at_ms INTEGER,
    last_throw_at_ms INTEGER,
    leaderboard_visible INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    CONSTRAINT players_public_tag_length CHECK (length(public_tag) = 4),
    CONSTRAINT players_score_not_above_throws
      CHECK (sandwiches_fed <= sandwiches_thrown),
    CONSTRAINT players_distinct_images CHECK (current_image_id <> next_image_id),
    CONSTRAINT players_leaderboard_visible_boolean
      CHECK (leaderboard_visible IN (0, 1))
  )`,
  `INSERT INTO __players_pack_reload (
    id, session_token_hash, nickname, public_tag, sandwiches_fed,
    sandwiches_thrown, packs_opened, pack_treats_remaining, score_version,
    current_image_id, next_image_id, last_accepted_at_ms, last_throw_at_ms,
    leaderboard_visible, created_at_ms, updated_at_ms
  ) SELECT
    id, session_token_hash, nickname, public_tag, sandwiches_fed,
    sandwiches_thrown, packs_opened, pack_treats_remaining, score_version,
    current_image_id, next_image_id, last_accepted_at_ms, last_throw_at_ms,
    leaderboard_visible, created_at_ms, updated_at_ms
  FROM players`,
  `DROP TABLE players`,
  `ALTER TABLE __players_pack_reload RENAME TO players`,
  `CREATE UNIQUE INDEX players_session_token_hash_unique
    ON players (session_token_hash)`,
  `CREATE UNIQUE INDEX players_public_tag_unique ON players (public_tag)`,
  `CREATE INDEX players_leaderboard_idx
    ON players (
      sandwiches_fed DESC,
      coalesce(last_accepted_at_ms, created_at_ms) ASC,
      id ASC
    )
    WHERE leaderboard_visible = 1`,
] as const;
