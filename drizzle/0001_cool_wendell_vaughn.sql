PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_players` (
	`id` text PRIMARY KEY NOT NULL,
	`session_token_hash` text NOT NULL,
	`nickname` text,
	`public_tag` text NOT NULL,
	`sandwiches_fed` integer DEFAULT 0 NOT NULL,
	`packs_opened` integer DEFAULT 1 NOT NULL,
	`score_version` integer DEFAULT 0 NOT NULL,
	`current_image_id` text NOT NULL,
	`next_image_id` text NOT NULL,
	`last_accepted_at_ms` integer,
	`leaderboard_visible` integer DEFAULT true NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "players_public_tag_length" CHECK(length("__new_players"."public_tag") = 4),
	CONSTRAINT "players_sandwiches_nonnegative" CHECK("__new_players"."sandwiches_fed" >= 0),
	CONSTRAINT "players_packs_opened_positive" CHECK("__new_players"."packs_opened" >= 1),
	CONSTRAINT "players_active_pack_window" CHECK("__new_players"."sandwiches_fed" >= ("__new_players"."packs_opened" - 1) * 6 AND "__new_players"."sandwiches_fed" <= "__new_players"."packs_opened" * 6),
	CONSTRAINT "players_score_version_nonnegative" CHECK("__new_players"."score_version" >= 0),
	CONSTRAINT "players_distinct_images" CHECK("__new_players"."current_image_id" <> "__new_players"."next_image_id"),
	CONSTRAINT "players_leaderboard_visible_boolean" CHECK("__new_players"."leaderboard_visible" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_players`("id", "session_token_hash", "nickname", "public_tag", "sandwiches_fed", "packs_opened", "score_version", "current_image_id", "next_image_id", "last_accepted_at_ms", "leaderboard_visible", "created_at_ms", "updated_at_ms") SELECT "id", "session_token_hash", "nickname", "public_tag", "sandwiches_fed", min(("sandwiches_fed" / 6) + 1, max(CASE WHEN "sandwiches_fed" = 0 THEN 1 ELSE (("sandwiches_fed" - 1) / 6) + 1 END, 1 + max(0, "score_version" - "sandwiches_fed"))), "score_version", "current_image_id", "next_image_id", "last_accepted_at_ms", "leaderboard_visible", "created_at_ms", "updated_at_ms" FROM `players`;--> statement-breakpoint
DROP TABLE `players`;--> statement-breakpoint
ALTER TABLE `__new_players` RENAME TO `players`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `players_session_token_hash_unique` ON `players` (`session_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `players_public_tag_unique` ON `players` (`public_tag`);--> statement-breakpoint
CREATE INDEX `players_leaderboard_idx` ON `players` ("sandwiches_fed" DESC, coalesce("last_accepted_at_ms", "created_at_ms"), "id") WHERE "players"."leaderboard_visible" = 1;
