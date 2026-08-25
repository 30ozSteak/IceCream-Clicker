CREATE TABLE IF NOT EXISTS `players` (
	`id` text PRIMARY KEY NOT NULL,
	`session_token_hash` text NOT NULL,
	`nickname` text,
	`public_tag` text NOT NULL,
	`sandwiches_fed` integer DEFAULT 0 NOT NULL,
	`score_version` integer DEFAULT 0 NOT NULL,
	`current_image_id` text NOT NULL,
	`next_image_id` text NOT NULL,
	`last_accepted_at_ms` integer,
	`leaderboard_visible` integer DEFAULT true NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "players_public_tag_length" CHECK(length("players"."public_tag") = 4),
	CONSTRAINT "players_sandwiches_nonnegative" CHECK("players"."sandwiches_fed" >= 0),
	CONSTRAINT "players_score_version_nonnegative" CHECK("players"."score_version" >= 0),
	CONSTRAINT "players_distinct_images" CHECK("players"."current_image_id" <> "players"."next_image_id"),
	CONSTRAINT "players_leaderboard_visible_boolean" CHECK("players"."leaderboard_visible" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `players_session_token_hash_unique` ON `players` (`session_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `players_public_tag_unique` ON `players` (`public_tag`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `players_leaderboard_idx` ON `players` ("sandwiches_fed" DESC,coalesce("last_accepted_at_ms", "created_at_ms"),`id`) WHERE "players"."leaderboard_visible" = 1;
