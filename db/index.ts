import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import {
  ADD_LAST_THROW_AT_COLUMN_SQL,
  ADD_PACK_TREATS_REMAINING_COLUMN_SQL,
  ADD_PACKS_OPENED_COLUMN_SQL,
  ADD_SANDWICHES_THROWN_COLUMN_SQL,
  BACKFILL_LAST_THROW_AT_SQL,
  BACKFILL_PACKS_OPENED_SQL,
  BACKFILL_PACK_TREATS_REMAINING_SQL,
  BACKFILL_SANDWICHES_THROWN_SQL,
  REBUILD_PLAYERS_FOR_PACK_RELOAD_SQL,
} from "./schema-maintenance";

const GAME_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS players (
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
    CONSTRAINT players_score_not_above_throws CHECK (
      sandwiches_fed <= sandwiches_thrown
    ),
    CONSTRAINT players_distinct_images CHECK (current_image_id <> next_image_id),
    CONSTRAINT players_leaderboard_visible_boolean CHECK (leaderboard_visible IN (0, 1))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS players_session_token_hash_unique
    ON players (session_token_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS players_public_tag_unique
    ON players (public_tag)`,
  `CREATE INDEX IF NOT EXISTS players_leaderboard_idx
    ON players (
      sandwiches_fed DESC,
      coalesce(last_accepted_at_ms, created_at_ms) ASC,
      id ASC
    )
    WHERE leaderboard_visible = 1`,
] as const;

export function getD1Binding(): D1Database {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` before using the game API.",
    );
  }

  return env.DB;
}

export function getDb() {
  return drizzle(getD1Binding(), { schema });
}

async function playerColumnNames(d1: D1Database): Promise<Set<string>> {
  const result = await d1
    .prepare("PRAGMA table_info(players)")
    .all<{ name: string }>();
  return new Set(result.results.map((column) => column.name));
}

async function playerTableDefinition(d1: D1Database): Promise<string> {
  const row = await d1
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'players'",
    )
    .first<{ sql: string }>();
  return row?.sql ?? "";
}

async function ensurePackStateSchema(
  d1: D1Database,
  columns: Set<string>,
): Promise<Set<string>> {
  if (columns.has("packs_opened")) {
    return columns;
  }

  try {
    await d1.prepare(ADD_PACKS_OPENED_COLUMN_SQL).run();
  } catch (error) {
    // Another request can win this idempotent upgrade between the PRAGMA and
    // ALTER. Re-read the schema and suppress only that successful race.
    const refreshedColumns = await playerColumnNames(d1);
    if (!refreshedColumns.has("packs_opened")) {
      throw error;
    }
  }

  await d1.prepare(BACKFILL_PACKS_OPENED_SQL).run();
  console.info(
    JSON.stringify({ message: "game_schema_upgraded", column: "packs_opened" }),
  );
  return playerColumnNames(d1);
}

async function ensureThrowStateSchema(
  d1: D1Database,
  initialColumns: Set<string>,
): Promise<Set<string>> {
  let columns = initialColumns;
  let upgraded = false;

  if (!columns.has("sandwiches_thrown")) {
    try {
      await d1.prepare(ADD_SANDWICHES_THROWN_COLUMN_SQL).run();
    } catch (error) {
      const refreshedColumns = await playerColumnNames(d1);
      if (!refreshedColumns.has("sandwiches_thrown")) {
        throw error;
      }
    }
    await d1.prepare(BACKFILL_SANDWICHES_THROWN_SQL).run();
    columns = await playerColumnNames(d1);
    upgraded = true;
  }

  if (!columns.has("last_throw_at_ms")) {
    try {
      await d1.prepare(ADD_LAST_THROW_AT_COLUMN_SQL).run();
    } catch (error) {
      const refreshedColumns = await playerColumnNames(d1);
      if (!refreshedColumns.has("last_throw_at_ms")) {
        throw error;
      }
    }
    await d1.prepare(BACKFILL_LAST_THROW_AT_SQL).run();
    columns = await playerColumnNames(d1);
    upgraded = true;
  }

  if (upgraded) {
    console.info(
      JSON.stringify({ message: "game_schema_upgraded", column: "throw_state" }),
    );
  }
  return columns;
}

async function ensurePackReloadStateSchema(
  d1: D1Database,
  columns: Set<string>,
): Promise<void> {
  let addedColumn = false;
  if (!columns.has("pack_treats_remaining")) {
    try {
      await d1.prepare(ADD_PACK_TREATS_REMAINING_COLUMN_SQL).run();
    } catch (error) {
      const refreshedColumns = await playerColumnNames(d1);
      if (!refreshedColumns.has("pack_treats_remaining")) {
        throw error;
      }
    }
    await d1.prepare(BACKFILL_PACK_TREATS_REMAINING_SQL).run();
    addedColumn = true;
  }

  const definition = await playerTableDefinition(d1);
  const needsRebuild =
    addedColumn ||
    definition.includes("players_active_pack_window") ||
    !definition.includes("players_score_not_above_throws");
  if (!needsRebuild) {
    return;
  }

  // The column can become visible to a concurrent request before the request
  // that added it reaches its backfill. Repeating this legacy-only calculation
  // before removing the old constraint makes an interrupted upgrade resumable.
  await d1.prepare(BACKFILL_PACK_TREATS_REMAINING_SQL).run();

  try {
    await d1.batch(
      REBUILD_PLAYERS_FOR_PACK_RELOAD_SQL.map((statement) =>
        d1.prepare(statement),
      ),
    );
  } catch (error) {
    // Another request may complete this transactional rebuild after our schema
    // inspection. Suppress only a race that left the full replacement schema.
    const refreshedDefinition = await playerTableDefinition(d1);
    const refreshedColumns = await playerColumnNames(d1);
    if (
      refreshedDefinition.includes("players_active_pack_window") ||
      !refreshedDefinition.includes("players_score_not_above_throws") ||
      !refreshedColumns.has("pack_treats_remaining")
    ) {
      throw error;
    }
  }

  console.info(
    JSON.stringify({ message: "game_schema_upgraded", feature: "pack_reload" }),
  );
}

/**
 * Sites can attach a brand-new D1 database before migrations are applied. Keep
 * runtime initialization idempotent so both that first request and local
 * previews work, while the generated migration remains the deployment source
 * of truth.
 */
export async function ensureGameSchema(): Promise<void> {
  const d1 = getD1Binding();
  await d1.batch(
    GAME_SCHEMA_STATEMENTS.map((statement) => d1.prepare(statement)),
  );
  let columns = await playerColumnNames(d1);
  columns = await ensurePackStateSchema(d1, columns);
  columns = await ensureThrowStateSchema(d1, columns);
  await ensurePackReloadStateSchema(d1, columns);
}
