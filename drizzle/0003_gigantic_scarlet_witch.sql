PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_players` (
	`id` text PRIMARY KEY NOT NULL,
	`session_token_hash` text NOT NULL,
	`nickname` text,
	`public_tag` text NOT NULL,
	`sandwiches_fed` integer DEFAULT 0 NOT NULL,
	`sandwiches_thrown` integer DEFAULT 0 NOT NULL,
	`packs_opened` integer DEFAULT 1 NOT NULL,
	`pack_treats_remaining` integer DEFAULT 6 NOT NULL,
	`current_pack_id` text DEFAULT 'vanilla-6' NOT NULL,
	`score_version` integer DEFAULT 0 NOT NULL,
	`current_image_id` text NOT NULL,
	`next_image_id` text NOT NULL,
	`last_accepted_at_ms` integer,
	`last_throw_at_ms` integer,
	`leaderboard_visible` integer DEFAULT true NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "players_public_tag_length" CHECK(length("__new_players"."public_tag") = 4),
	CONSTRAINT "players_sandwiches_nonnegative" CHECK("__new_players"."sandwiches_fed" >= 0),
	CONSTRAINT "players_sandwiches_thrown_nonnegative" CHECK("__new_players"."sandwiches_thrown" >= 0),
	CONSTRAINT "players_score_not_above_throws" CHECK("__new_players"."sandwiches_fed" <= "__new_players"."sandwiches_thrown"),
	CONSTRAINT "players_packs_opened_positive" CHECK("__new_players"."packs_opened" >= 1),
	CONSTRAINT "players_pack_treats_remaining_range" CHECK("__new_players"."pack_treats_remaining" BETWEEN 0 AND 12),
	CONSTRAINT "players_score_version_nonnegative" CHECK("__new_players"."score_version" >= 0),
	CONSTRAINT "players_distinct_images" CHECK("__new_players"."current_image_id" <> "__new_players"."next_image_id"),
	CONSTRAINT "players_leaderboard_visible_boolean" CHECK("__new_players"."leaderboard_visible" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_players`("id", "session_token_hash", "nickname", "public_tag", "sandwiches_fed", "sandwiches_thrown", "packs_opened", "pack_treats_remaining", "current_pack_id", "score_version", "current_image_id", "next_image_id", "last_accepted_at_ms", "last_throw_at_ms", "leaderboard_visible", "created_at_ms", "updated_at_ms") SELECT "id", "session_token_hash", "nickname", "public_tag", "sandwiches_fed", "sandwiches_thrown", "packs_opened", "pack_treats_remaining", 'vanilla-6', "score_version", "current_image_id", "next_image_id", "last_accepted_at_ms", "last_throw_at_ms", "leaderboard_visible", "created_at_ms", "updated_at_ms" FROM `players`;--> statement-breakpoint
DROP TABLE `players`;--> statement-breakpoint
ALTER TABLE `__new_players` RENAME TO `players`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `players_session_token_hash_unique` ON `players` (`session_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `players_public_tag_unique` ON `players` (`public_tag`);--> statement-breakpoint
CREATE INDEX `players_leaderboard_idx` ON `players` (
	"sandwiches_fed" DESC,
	coalesce("last_accepted_at_ms", "created_at_ms"),
	"id"
) WHERE "players"."leaderboard_visible" = 1;
