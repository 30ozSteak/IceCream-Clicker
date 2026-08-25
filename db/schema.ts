import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { MAX_PACK_QUANTITY } from "../lib/packs";

export const players = pgTable(
  "players",
  {
    id: text("id").primaryKey(),
    sessionTokenHash: text("session_token_hash").notNull().unique(),
    nickname: text("nickname"),
    publicTag: text("public_tag").notNull().unique(),
    sandwichesFed: bigint("sandwiches_fed", { mode: "number" })
      .notNull()
      .default(0),
    sandwichesThrown: bigint("sandwiches_thrown", { mode: "number" })
      .notNull()
      .default(0),
    packsOpened: bigint("packs_opened", { mode: "number" })
      .notNull()
      .default(1),
    packTreatsRemaining: integer("pack_treats_remaining").notNull().default(6),
    currentPackId: text("current_pack_id").notNull().default("vanilla-6"),
    scoreVersion: bigint("score_version", { mode: "number" })
      .notNull()
      .default(0),
    currentImageId: text("current_image_id").notNull(),
    nextImageId: text("next_image_id").notNull(),
    lastAcceptedAtMs: bigint("last_accepted_at_ms", { mode: "number" }),
    lastThrowAtMs: bigint("last_throw_at_ms", { mode: "number" }),
    leaderboardVisible: boolean("leaderboard_visible").notNull().default(true),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    check("players_public_tag_length", sql`length(${table.publicTag}) = 4`),
    check("players_sandwiches_nonnegative", sql`${table.sandwichesFed} >= 0`),
    check(
      "players_sandwiches_thrown_nonnegative",
      sql`${table.sandwichesThrown} >= 0`,
    ),
    check(
      "players_score_not_above_throws",
      sql`${table.sandwichesFed} <= ${table.sandwichesThrown}`,
    ),
    check("players_packs_opened_positive", sql`${table.packsOpened} >= 1`),
    check(
      "players_pack_treats_remaining_range",
      sql`${table.packTreatsRemaining} BETWEEN 0 AND ${sql.raw(String(MAX_PACK_QUANTITY))}`,
    ),
    check("players_score_version_nonnegative", sql`${table.scoreVersion} >= 0`),
    check(
      "players_distinct_images",
      sql`${table.currentImageId} <> ${table.nextImageId}`,
    ),
    index("players_leaderboard_idx")
      .on(
        sql`${table.sandwichesFed} DESC`,
        sql`coalesce(${table.lastAcceptedAtMs}, ${table.createdAtMs})`,
        table.id,
      )
      .where(sql`${table.leaderboardVisible} = true`),
  ],
);

export type PlayerRow = typeof players.$inferSelect;
