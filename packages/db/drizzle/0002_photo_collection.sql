ALTER TABLE `magic_tokens` ADD `label` text;--> statement-breakpoint
ALTER TABLE `magic_tokens` ADD `ask_template` text;--> statement-breakpoint
ALTER TABLE `magic_tokens` ADD `ask_note` text;--> statement-breakpoint
ALTER TABLE `magic_tokens` ADD `deadline_at` integer;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `era_guess` text;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `dupe_representative` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `needs_identification` integer DEFAULT false NOT NULL;