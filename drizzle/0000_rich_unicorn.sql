CREATE TABLE `saved_combos` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`combo_id` text NOT NULL,
	`combo_json` text NOT NULL,
	`status` text DEFAULT 'research' NOT NULL,
	`stake` real DEFAULT 0 NOT NULL,
	`entry_cost` real,
	`saved_at` text NOT NULL,
	`updated_at` text NOT NULL
);
