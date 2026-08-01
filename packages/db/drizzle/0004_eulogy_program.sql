CREATE TABLE `eulogy_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`speech_id` text NOT NULL,
	`version` integer NOT NULL,
	`variant` text DEFAULT 'full' NOT NULL,
	`speaker_name` text DEFAULT '' NOT NULL,
	`relationship` text,
	`target_minutes` integer DEFAULT 5 NOT NULL,
	`tone` text DEFAULT 'warm-with-laughter' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`notes` text,
	`status` text DEFAULT 'setup' NOT NULL,
	`created_by` text DEFAULT 'organizer' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eulogy_drafts_speech_version_idx` ON `eulogy_drafts` (`speech_id`,`version`);--> statement-breakpoint
CREATE INDEX `eulogy_drafts_memorial_idx` ON `eulogy_drafts` (`memorial_id`);--> statement-breakpoint
CREATE TABLE `program_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`version` integer NOT NULL,
	`doc` text NOT NULL,
	`created_by` text DEFAULT 'organizer' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_docs_memorial_version_idx` ON `program_docs` (`memorial_id`,`version`);