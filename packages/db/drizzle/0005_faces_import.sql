CREATE TABLE `face_detections` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`box` text NOT NULL,
	`embedding` text NOT NULL,
	`quality` real DEFAULT 0 NOT NULL,
	`engine` text DEFAULT 'mock' NOT NULL,
	`cluster_id` text,
	`person_id` text,
	`dismissed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `face_detections_memorial_idx` ON `face_detections` (`memorial_id`);--> statement-breakpoint
CREATE INDEX `face_detections_asset_idx` ON `face_detections` (`asset_id`);--> statement-breakpoint
CREATE INDEX `face_detections_cluster_idx` ON `face_detections` (`memorial_id`,`cluster_id`);--> statement-breakpoint
CREATE INDEX `face_detections_person_idx` ON `face_detections` (`memorial_id`,`person_id`);--> statement-breakpoint
ALTER TABLE `media_assets` ADD `enhance_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `enhance_engine` text;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `enhance_note` text;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `enhanced_at` integer;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `enhance_accepted_at` integer;--> statement-breakpoint
ALTER TABLE `memorials` ADD `face_grouping_started_at` integer;