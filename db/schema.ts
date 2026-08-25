import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const players = sqliteTable(
  "players",
  {
    id: text("id").primaryKey(),
    sessionTokenHash: text("session_token_hash").notNull().unique(),
    nickname: text("nickname"),
    publicTag: text("public_tag").notNull().unique(),
    sandwichesFed: integer("sandwiches_fed").notNull().default(0),
    scoreVersion: integer("score_version").notNull().default(0),
    currentImageId: text("current_image_id").notNull(),
    nextImageId: text("next_image_id").notNull(),
    lastAcceptedAtMs: integer("last_accepted_at_ms"),
    leaderboardVisible: integer("leaderboard_visible", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check("players_public_tag_length", sql`length(${table.publicTag}) = 4`),
    check("players_sandwiches_nonnegative", sql`${table.sandwichesFed} >= 0`),
    check("players_score_version_nonnegative", sql`${table.scoreVersion} >= 0`),
    check(
      "players_distinct_images",
      sql`${table.currentImageId} <> ${table.nextImageId}`,
    ),
    check(
      "players_leaderboard_visible_boolean",
      sql`${table.leaderboardVisible} IN (0, 1)`,
    ),
    index("players_leaderboard_idx")
      .on(
        sql`${table.sandwichesFed} DESC`,
        sql`coalesce(${table.lastAcceptedAtMs}, ${table.createdAtMs})`,
        table.id,
      )
      .where(sql`${table.leaderboardVisible} = 1`),
  ],
);

export type PlayerRow = typeof players.$inferSelect;
