CREATE TABLE `asset_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`kind` text NOT NULL,
	`blob_key` text NOT NULL,
	`mime` text NOT NULL,
	`width` integer,
	`height` integer,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_variants_asset_kind_idx` ON `asset_variants` (`asset_id`,`kind`);--> statement-breakpoint
CREATE TABLE `interview_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`participant_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`provider_session_id` text,
	`provider_id` text,
	`current_prompt_slug` text,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`last_active_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `interview_sessions_memorial_idx` ON `interview_sessions` (`memorial_id`);--> statement-breakpoint
CREATE TABLE `interview_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`memorial_id` text NOT NULL,
	`idx` integer NOT NULL,
	`role` text NOT NULL,
	`prompt_slug` text,
	`text` text DEFAULT '' NOT NULL,
	`skipped` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interview_turns_session_idx_idx` ON `interview_turns` (`session_id`,`idx`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_after` integer NOT NULL,
	`lease_expires_at` integer,
	`locked_by` text,
	`last_error` text,
	`result` text,
	`memorial_id` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_lease_idx` ON `jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_memorial_idx` ON `jobs` (`memorial_id`);--> statement-breakpoint
CREATE TABLE `life_story_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`version` integer NOT NULL,
	`doc` text NOT NULL,
	`created_by` text DEFAULT 'system' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `life_story_docs_memorial_version_idx` ON `life_story_docs` (`memorial_id`,`version`);--> statement-breakpoint
CREATE TABLE `magic_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`participant_id` text,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`expires_at` integer,
	`used_count` integer DEFAULT 0 NOT NULL,
	`max_uses` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `magic_tokens_token_hash_idx` ON `magic_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `magic_tokens_memorial_idx` ON `magic_tokens` (`memorial_id`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`uploaded_by_participant_id` text,
	`original_filename` text,
	`mime` text NOT NULL,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`width` integer,
	`height` integer,
	`captured_at` integer,
	`blob_key` text NOT NULL,
	`phash` text,
	`quality_score` real,
	`blur_score` real,
	`dupe_group_id` text,
	`analysis` text,
	`curation_state` text DEFAULT 'pending' NOT NULL,
	`caption` text,
	`sort_hint` real,
	`ingest_state` text DEFAULT 'uploaded' NOT NULL,
	`ingest_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `media_assets_memorial_curation_idx` ON `media_assets` (`memorial_id`,`curation_state`);--> statement-breakpoint
CREATE INDEX `media_assets_dupe_group_idx` ON `media_assets` (`dupe_group_id`);--> statement-breakpoint
CREATE TABLE `memorials` (
	`id` text PRIMARY KEY NOT NULL,
	`decedent_name` text NOT NULL,
	`decedent_known_as` text,
	`birth_year` integer,
	`death_year` integer,
	`tradition_slug` text DEFAULT 'secular' NOT NULL,
	`pacing_preset` text DEFAULT 'flexible' NOT NULL,
	`service_date` integer,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`organizer_relationship` text,
	`ai_consent_external` integer DEFAULT false NOT NULL,
	`ai_consent_photo_analysis` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`checklist` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `memory_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`asset_id` text,
	`participant_id` text,
	`author_name` text,
	`prompt_slug` text,
	`text` text NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memory_notes_memorial_idx` ON `memory_notes` (`memorial_id`);--> statement-breakpoint
CREATE TABLE `music_selections` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`project_id` text NOT NULL,
	`track_id` text,
	`mode` text NOT NULL,
	`sideloaded_title` text,
	`sideloaded_artist` text,
	`start_offset_sec` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `slideshow_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `music_tracks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `music_selections_project_idx` ON `music_selections` (`project_id`);--> statement-breakpoint
CREATE TABLE `music_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`artist` text,
	`license_kind` text NOT NULL,
	`license_note` text,
	`source_url` text,
	`blob_key` text,
	`duration_sec` real,
	`bpm` real,
	`beat_grid` text,
	`mood_tags` text DEFAULT '[]' NOT NULL,
	`tradition_tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `music_tracks_slug_idx` ON `music_tracks` (`slug`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`person_id` text,
	`role` text NOT NULL,
	`display_name` text,
	`email` text,
	`invited_at` integer,
	`last_seen_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `participants_memorial_role_idx` ON `participants` (`memorial_id`,`role`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`full_name` text NOT NULL,
	`known_as` text,
	`relationship` text,
	`is_decedent` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `people_memorial_idx` ON `people` (`memorial_id`);--> statement-breakpoint
CREATE TABLE `render_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`project_id` text NOT NULL,
	`job_id` text,
	`cut` text NOT NULL,
	`preset` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`output_blob_key` text,
	`duration_sec` real,
	`ffprobe_meta` text,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `slideshow_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `render_jobs_memorial_status_idx` ON `render_jobs` (`memorial_id`,`status`);--> statement-breakpoint
CREATE TABLE `slideshow_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`name` text DEFAULT 'Tribute slideshow' NOT NULL,
	`edl` text,
	`edl_version` integer DEFAULT 0 NOT NULL,
	`audio_mode` text DEFAULT 'cleared' NOT NULL,
	`theme_id` text DEFAULT 'quiet-linen' NOT NULL,
	`service_target_sec` integer DEFAULT 300 NOT NULL,
	`family_target_sec` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slideshow_projects_memorial_idx` ON `slideshow_projects` (`memorial_id`);