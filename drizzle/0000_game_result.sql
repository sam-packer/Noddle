CREATE TABLE `game_result` (
	`id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`players` integer NOT NULL,
	`winner_seat` integer,
	`ended_at` integer NOT NULL
);
