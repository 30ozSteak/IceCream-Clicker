import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import {
  ADD_PACKS_OPENED_COLUMN_SQL,
  BACKFILL_PACKS_OPENED_SQL,
} from "./schema-maintenance";

const GAME_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY NOT NULL,
    session_token_hash TEXT NOT NULL,
    nickname TEXT,
    public_tag TEXT NOT NULL,
    sandwiches_fed INTEGER NOT NULL DEFAULT 0 CHECK (sandwiches_fed >= 0),
    packs_opened INTEGER NOT NULL DEFAULT 1 CHECK (packs_opened >= 1),
    score_version INTEGER NOT NULL DEFAULT 0 CHECK (score_version >= 0),
    current_image_id TEXT NOT NULL,
    next_image_id TEXT NOT NULL,
    last_accepted_at_ms INTEGER,
    leaderboard_visible INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    CONSTRAINT players_public_tag_length CHECK (length(public_tag) = 4),
    CONSTRAINT players_active_pack_window CHECK (
      sandwiches_fed >= (packs_opened - 1) * 6
      AND sandwiches_fed <= packs_opened * 6
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

async function ensurePackStateSchema(d1: D1Database): Promise<void> {
  const columns = await playerColumnNames(d1);
  if (columns.has("packs_opened")) {
    return;
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
  console.info(JSON.stringify({ message: "game_schema_upgraded", column: "packs_opened" }));
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
  await ensurePackStateSchema(d1);
}
