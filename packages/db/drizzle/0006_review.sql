CREATE TABLE `review_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`render_job_id` text,
	`author_name` text,
	`body` text NOT NULL,
	`timecode_ms` integer,
	`slide_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_via` text DEFAULT 'watch' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`render_job_id`) REFERENCES `render_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_notes_memorial_status_idx` ON `review_notes` (`memorial_id`,`status`);