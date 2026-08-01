/**
 * Drizzle schema — SQLite today, Postgres-portable by construction.
 *
 * Conventions (hold these everywhere):
 *  - primary keys are text UUIDv7 (sortable, no sequence, safe to generate client-side)
 *  - timestamps are integer epoch-milliseconds, never SQLite date strings
 *  - JSON lives in text columns and is validated by zod at the boundary
 *  - soft delete = `deletedAt`; hard delete is a separate, real purge
 */
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  BeatGrid,
  Edl,
  EulogyNotes,
  FaceBox,
  JobType,
  LifeStoryDocument,
  PhotoAnalysis,
  ProgramDocument,
} from '@col/schemas';
import { newId } from './ids';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => newId());

const createdAt = () =>
  integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now());

const updatedAt = () =>
  integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());

/* -------------------------------------------------------------------------- */
/* memorials                                                                   */
/* -------------------------------------------------------------------------- */

export type MemorialChecklist = Record<string, boolean>;

export const memorials = sqliteTable('memorials', {
  id: id(),
  decedentName: text('decedent_name').notNull(),
  decedentKnownAs: text('decedent_known_as'),
  birthYear: integer('birth_year'),
  deathYear: integer('death_year'),
  /** Slug into packages/tradition-packs. Never branched on in code. */
  traditionSlug: text('tradition_slug').notNull().default('secular'),
  /** Derived from tradition + service date at intake. */
  pacingPreset: text('pacing_preset', {
    enum: ['urgent24h', 'days3to7', 'memorial-cycle', 'flexible'],
  })
    .notNull()
    .default('flexible'),
  serviceDate: integer('service_date'),
  timezone: text('timezone').notNull().default('UTC'),
  organizerRelationship: text('organizer_relationship'),
  /** What the family is holding: funeral, celebration of life, memorial, undecided. */
  gatheringKind: text('gathering_kind'),
  /**
   * Furthest intake question reached. Every intake answer is optional, so
   * "answered" cannot be inferred from the columns being null — a skip and a
   * never-seen question look identical. This is what lets a half-finished
   * wizard resume exactly where the tab was closed.
   */
  intakeStep: text('intake_step'),
  intakeCompletedAt: integer('intake_completed_at'),
  /** Consent, per memorial, in plain language. Off until explicitly granted. */
  aiConsentExternal: integer('ai_consent_external', { mode: 'boolean' }).notNull().default(false),
  aiConsentPhotoAnalysis: integer('ai_consent_photo_analysis', { mode: 'boolean' })
    .notNull()
    .default(false),
  /**
   * When the organizer asked us to look for the same faces across the
   * photographs. Face work never leaves this machine, so this is not consent to
   * send anything anywhere — it is the record that a person chose it, which is
   * what makes the feature explainable to the rest of the family later.
   */
  faceGroupingStartedAt: integer('face_grouping_started_at'),
  status: text('status', { enum: ['draft', 'active', 'delivered', 'archived'] })
    .notNull()
    .default('draft'),
  checklist: text('checklist', { mode: 'json' }).$type<MemorialChecklist>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  /** Soft delete (tombstone). A purge-blobs job does the real removal. */
  deletedAt: integer('deleted_at'),
});

/* -------------------------------------------------------------------------- */
/* people                                                                      */
/* -------------------------------------------------------------------------- */

export const people = sqliteTable(
  'people',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    knownAs: text('known_as'),
    /** Relationship to the person who died, e.g. "daughter". */
    relationship: text('relationship'),
    isDecedent: integer('is_decedent', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('people_memorial_idx').on(t.memorialId)],
);

/* -------------------------------------------------------------------------- */
/* participants                                                                */
/* -------------------------------------------------------------------------- */

export const participants = sqliteTable(
  'participants',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    personId: text('person_id').references(() => people.id, { onDelete: 'set null' }),
    role: text('role', { enum: ['organizer', 'contributor'] }).notNull(),
    displayName: text('display_name'),
    email: text('email'),
    invitedAt: integer('invited_at'),
    lastSeenAt: integer('last_seen_at'),
    revokedAt: integer('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('participants_memorial_role_idx').on(t.memorialId, t.role)],
);

/* -------------------------------------------------------------------------- */
/* magic_tokens                                                                */
/* -------------------------------------------------------------------------- */

export const magicTokens = sqliteTable(
  'magic_tokens',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    participantId: text('participant_id').references(() => participants.id, {
      onDelete: 'cascade',
    }),
    /** Only ever the hash. The plaintext exists solely inside the emailed link. */
    tokenHash: text('token_hash').notNull(),
    /**
     * 'collection-link' is the one link a family shares with everyone;
     * 'contributor' is a personal ask made of one person. Both land on the same
     * contributor pages — the difference is what the landing page says.
     */
    kind: text('kind', {
      enum: ['organizer-login', 'collection-link', 'contributor', 'watch'],
    }).notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Who this link was made for, in the organiser's words: "Aunt Mary". */
    label: text('label'),
    /** Which bounded-ask template produced it, e.g. 'younger-years'. */
    askTemplate: text('ask_template'),
    /** The ask itself, as the person receiving the link will read it. */
    askNote: text('ask_note'),
    /** A gentle "by Wednesday", not an expiry — the link keeps working after it. */
    deadlineAt: integer('deadline_at'),
    expiresAt: integer('expires_at'),
    usedCount: integer('used_count').notNull().default(0),
    maxUses: integer('max_uses'),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('magic_tokens_token_hash_idx').on(t.tokenHash),
    index('magic_tokens_memorial_idx').on(t.memorialId),
  ],
);

/* -------------------------------------------------------------------------- */
/* media_assets + asset_variants                                               */
/* -------------------------------------------------------------------------- */

export const mediaAssets = sqliteTable(
  'media_assets',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    uploadedByParticipantId: text('uploaded_by_participant_id').references(() => participants.id, {
      onDelete: 'set null',
    }),
    originalFilename: text('original_filename'),
    mime: text('mime').notNull(),
    byteSize: integer('byte_size').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    /** EXIF capture time when we can read one; drives era grouping. */
    capturedAt: integer('captured_at'),
    /** Decade label derived from capturedAt, e.g. '1960s'. Null = "when was this?". */
    eraGuess: text('era_guess'),
    /** Blob keys are prefixed memorial/{id}/ so hard delete can purge by prefix. */
    blobKey: text('blob_key').notNull(),
    /** Perceptual hash (sharp-phash) for near-duplicate grouping. */
    phash: text('phash'),
    /** 0..1 overall usability; blurScore is the variance-of-Laplacian component. */
    qualityScore: real('quality_score'),
    blurScore: real('blur_score'),
    dupeGroupId: text('dupe_group_id'),
    /** The member of its dupe group the grid shows. The family can change it. */
    dupeRepresentative: integer('dupe_representative', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** "Who is this?" — raised by the organiser, answered by whoever knows. */
    needsIdentification: integer('needs_identification', { mode: 'boolean' })
      .notNull()
      .default(false),
    analysis: text('analysis', { mode: 'json' }).$type<PhotoAnalysis>(),
    /** Blurry photos are flagged, never silently removed — the family decides. */
    curationState: text('curation_state', {
      enum: ['pending', 'approved', 'rejected', 'flagged', 'hidden'],
    })
      .notNull()
      .default('pending'),
    caption: text('caption'),
    sortHint: real('sort_hint'),
    /**
     * The opt-in restoration, which is never applied to anything: the original
     * bytes and the plain `render2400` both stay exactly as they were, and this
     * only records whether an `enhanced2400` variant exists and whether the
     * family said they preferred it. 'accepted' is reversible in one tap.
     */
    enhanceState: text('enhance_state', {
      enum: ['none', 'queued', 'ready', 'accepted', 'failed'],
    })
      .notNull()
      .default('none'),
    /** Which restorer made it: 'sharp', or the external command's name. */
    enhanceEngine: text('enhance_engine'),
    /** What actually changed, in measured numbers, for the before/after copy. */
    enhanceNote: text('enhance_note'),
    enhancedAt: integer('enhanced_at'),
    /** Set when the family chose the improved copy. Null means the original. */
    enhanceAcceptedAt: integer('enhance_accepted_at'),
    ingestState: text('ingest_state', { enum: ['uploaded', 'processing', 'ready', 'failed'] })
      .notNull()
      .default('uploaded'),
    ingestError: text('ingest_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('media_assets_memorial_curation_idx').on(t.memorialId, t.curationState),
    index('media_assets_dupe_group_idx').on(t.dupeGroupId),
  ],
);

export const assetVariants = sqliteTable(
  'asset_variants',
  {
    id: id(),
    assetId: text('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['thumb320', 'web1600', 'render2400', 'enhanced2400', 'original'],
    }).notNull(),
    blobKey: text('blob_key').notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    byteSize: integer('byte_size').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('asset_variants_asset_kind_idx').on(t.assetId, t.kind)],
);

/* -------------------------------------------------------------------------- */
/* face_detections                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One row per face found in one photograph, and nothing else.
 *
 * Three deliberate choices live in this table:
 *
 *  - `memorialId` is carried even though it is reachable through the asset.
 *    Deletion is why: a family removing a memorial must take every face vector
 *    with it, and a purge that has to join through another table to find them
 *    is a purge that will one day miss some.
 *  - `clusterId` is recomputed from scratch every time grouping runs, so it is
 *    a label rather than an identity. `personId` is the identity, because that
 *    is the part a person typed, and it must survive new photographs arriving
 *    and the grouping being redone.
 *  - `dismissedAt` records "these are not the same person" so the strip does
 *    not keep asking. It is a tombstone on a suggestion, not on a photograph.
 */
export const faceDetections = sqliteTable(
  'face_detections',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    /** Where the face is, in 0..1 of the picture. Drives the crop in the strip. */
    box: text('box', { mode: 'json' }).$type<FaceBox>().notNull(),
    /** The descriptor. Never sent anywhere; deleted with the memorial. */
    embedding: text('embedding', { mode: 'json' }).$type<number[]>().notNull(),
    quality: real('quality').notNull().default(0),
    /** Which engine produced it, so a model change can be re-run knowingly. */
    engine: text('engine').notNull().default('mock'),
    /** Recomputed label from the last grouping pass. */
    clusterId: text('cluster_id'),
    /** Set once somebody says "this is Ruth". */
    personId: text('person_id').references(() => people.id, { onDelete: 'set null' }),
    /** "Not the same person" — the suggestion is put away, the faces stay. */
    dismissedAt: integer('dismissed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('face_detections_memorial_idx').on(t.memorialId),
    index('face_detections_asset_idx').on(t.assetId),
    index('face_detections_cluster_idx').on(t.memorialId, t.clusterId),
    index('face_detections_person_idx').on(t.memorialId, t.personId),
  ],
);

/* -------------------------------------------------------------------------- */
/* memory_notes                                                                */
/* -------------------------------------------------------------------------- */

export const memoryNotes = sqliteTable(
  'memory_notes',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').references(() => mediaAssets.id, { onDelete: 'cascade' }),
    participantId: text('participant_id').references(() => participants.id, {
      onDelete: 'set null',
    }),
    authorName: text('author_name'),
    /** Which bounded ask produced this note, if any. */
    promptSlug: text('prompt_slug'),
    text: text('text').notNull(),
    approved: integer('approved', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('memory_notes_memorial_idx').on(t.memorialId)],
);

/* -------------------------------------------------------------------------- */
/* life_story_docs (append-only, versioned)                                    */
/* -------------------------------------------------------------------------- */

export const lifeStoryDocs = sqliteTable(
  'life_story_docs',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    doc: text('doc', { mode: 'json' }).$type<LifeStoryDocument>().notNull(),
    /** 'interview' | 'organizer' | 'ai' — who produced this revision. */
    createdBy: text('created_by').notNull().default('system'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('life_story_docs_memorial_version_idx').on(t.memorialId, t.version)],
);

/* -------------------------------------------------------------------------- */
/* interview_sessions / interview_turns                                        */
/* -------------------------------------------------------------------------- */

export const interviewSessions = sqliteTable(
  'interview_sessions',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    participantId: text('participant_id').references(() => participants.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: ['active', 'paused', 'complete'] })
      .notNull()
      .default('active'),
    /** Provider-side conversation id. An optimisation, never a requirement. */
    providerSessionId: text('provider_session_id'),
    providerId: text('provider_id'),
    currentPromptSlug: text('current_prompt_slug'),
    turnCount: integer('turn_count').notNull().default(0),
    startedAt: integer('started_at')
      .notNull()
      .$defaultFn(() => Date.now()),
    lastActiveAt: integer('last_active_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('interview_sessions_memorial_idx').on(t.memorialId)],
);

export const interviewTurns = sqliteTable(
  'interview_turns',
  {
    id: id(),
    sessionId: text('session_id')
      .notNull()
      .references(() => interviewSessions.id, { onDelete: 'cascade' }),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    /** 0-based position within the session. */
    idx: integer('idx').notNull(),
    role: text('role', { enum: ['assistant', 'user'] }).notNull(),
    promptSlug: text('prompt_slug'),
    text: text('text').notNull().default(''),
    /** "Skip" is a first-class answer, not a failure. */
    skipped: integer('skipped', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('interview_turns_session_idx_idx').on(t.sessionId, t.idx)],
);

/* -------------------------------------------------------------------------- */
/* slideshow_projects                                                          */
/* -------------------------------------------------------------------------- */

export const slideshowProjects = sqliteTable(
  'slideshow_projects',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('Tribute slideshow'),
    edl: text('edl', { mode: 'json' }).$type<Edl>(),
    edlVersion: integer('edl_version').notNull().default(0),
    audioMode: text('audio_mode', { enum: ['cleared', 'sideloaded'] })
      .notNull()
      .default('cleared'),
    themeId: text('theme_id').notNull().default('quiet-linen'),
    /** Two cuts are first-class: a tight service cut and a longer family cut. */
    serviceTargetSec: integer('service_target_sec').notNull().default(300),
    familyTargetSec: integer('family_target_sec'),
    status: text('status', { enum: ['draft', 'ready', 'rendered'] })
      .notNull()
      .default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('slideshow_projects_memorial_idx').on(t.memorialId)],
);

/* -------------------------------------------------------------------------- */
/* music_tracks / music_selections                                             */
/* -------------------------------------------------------------------------- */

export const musicTracks = sqliteTable(
  'music_tracks',
  {
    id: id(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    artist: text('artist'),
    /**
     * Commercial songs cannot be baked into a shareable video without a sync
     * licence. Only 'public-domain' and 'royalty-free' tracks are bakeable.
     */
    licenseKind: text('license_kind', {
      enum: ['public-domain', 'royalty-free', 'family-supplied'],
    }).notNull(),
    licenseNote: text('license_note'),
    sourceUrl: text('source_url'),
    blobKey: text('blob_key'),
    durationSec: real('duration_sec'),
    bpm: real('bpm'),
    beatGrid: text('beat_grid', { mode: 'json' }).$type<BeatGrid>(),
    moodTags: text('mood_tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Traditions this track suits; empty means "no restriction". */
    traditionTags: text('tradition_tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('music_tracks_slug_idx').on(t.slug)],
);

export const musicSelections = sqliteTable(
  'music_selections',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => slideshowProjects.id, { onDelete: 'cascade' }),
    trackId: text('track_id').references(() => musicTracks.id, { onDelete: 'set null' }),
    mode: text('mode', { enum: ['cleared', 'sideloaded'] }).notNull(),
    /** For sideloaded mode: what the venue will play, for the director card. */
    sideloadedTitle: text('sideloaded_title'),
    sideloadedArtist: text('sideloaded_artist'),
    startOffsetSec: real('start_offset_sec').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('music_selections_project_idx').on(t.projectId)],
);

/* -------------------------------------------------------------------------- */
/* render_jobs                                                                 */
/* -------------------------------------------------------------------------- */

export const renderJobs = sqliteTable(
  'render_jobs',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => slideshowProjects.id, { onDelete: 'cascade' }),
    /** The queue row that actually does the work. */
    jobId: text('job_id'),
    cut: text('cut', { enum: ['service', 'family'] }).notNull(),
    preset: text('preset', { enum: ['draft360', 'final1080', 'backup720'] }).notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    progress: real('progress').notNull().default(0),
    outputBlobKey: text('output_blob_key'),
    durationSec: real('duration_sec'),
    /** ffprobe output, asserted against before we ever call a render "done". */
    ffprobeMeta: text('ffprobe_meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    error: text('error'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('render_jobs_memorial_status_idx').on(t.memorialId, t.status)],
);

/* -------------------------------------------------------------------------- */
/* eulogy_drafts (append-only, versioned)                                      */
/* -------------------------------------------------------------------------- */

/**
 * One row per version of one speech.
 *
 * `speechId` is what a speech *is* — several people speak at a funeral, and each
 * of them keeps their own drafts. Versions share the sequence within a speech,
 * so "the previous one" is always one row back whatever produced it, and
 * nothing a person wrote is ever overwritten by a model or by a tool button.
 */
export const eulogyDrafts = sqliteTable(
  'eulogy_drafts',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    /** Stable across every version of this speech. */
    speechId: text('speech_id').notNull(),
    version: integer('version').notNull(),
    /** The full speech, or the ninety-second graveside form of it. */
    variant: text('variant', { enum: ['full', 'graveside'] })
      .notNull()
      .default('full'),
    speakerName: text('speaker_name').notNull().default(''),
    /** How they were related, in their own words: "her daughter". */
    relationship: text('relationship'),
    targetMinutes: integer('target_minutes').notNull().default(5),
    tone: text('tone', { enum: ['warm-with-laughter', 'quiet-and-simple', 'faithful'] })
      .notNull()
      .default('warm-with-laughter'),
    /** Paragraphs, blank-line separated, with `[pause]` markers left in place. */
    body: text('body').notNull().default(''),
    /** Opening/closing lines, chosen memories, and what assembly had to change. */
    notes: text('notes', { mode: 'json' }).$type<EulogyNotes>(),
    status: text('status', { enum: ['setup', 'draft', 'ready'] })
      .notNull()
      .default('setup'),
    /** 'ai' | 'organizer' — who produced this version. */
    createdBy: text('created_by').notNull().default('organizer'),
    /** Why this version exists: "A little shorter", "Edited by hand". */
    note: text('note'),
    createdAt: createdAt(),
    /** Soft delete removes a whole speech; every version carries the tombstone. */
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('eulogy_drafts_speech_version_idx').on(t.speechId, t.version),
    index('eulogy_drafts_memorial_idx').on(t.memorialId),
  ],
);

/* -------------------------------------------------------------------------- */
/* program_docs (append-only, versioned)                                       */
/* -------------------------------------------------------------------------- */

export const programDocs = sqliteTable(
  'program_docs',
  {
    id: id(),
    memorialId: text('memorial_id')
      .notNull()
      .references(() => memorials.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    doc: text('doc', { mode: 'json' }).$type<ProgramDocument>().notNull(),
    /** 'organizer' | 'ai' | 'system' — who produced this revision. */
    createdBy: text('created_by').notNull().default('organizer'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('program_docs_memorial_version_idx').on(t.memorialId, t.version)],
);

/* -------------------------------------------------------------------------- */
/* jobs (generic durable queue)                                                */
/* -------------------------------------------------------------------------- */

export const jobs = sqliteTable(
  'jobs',
  {
    id: id(),
    type: text('type').$type<JobType>().notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    /** Higher runs first. Renders outrank purges; purges outrank analysis. */
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Not eligible to be claimed before this epoch-ms. Drives backoff. */
    runAfter: integer('run_after')
      .notNull()
      .$defaultFn(() => Date.now()),
    /** A running job whose lease has expired is reclaimable by another worker. */
    leaseExpiresAt: integer('lease_expires_at'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    memorialId: text('memorial_id'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_status_run_after_idx').on(t.status, t.runAfter),
    index('jobs_lease_idx').on(t.status, t.leaseExpiresAt),
    index('jobs_memorial_idx').on(t.memorialId),
  ],
);

/* -------------------------------------------------------------------------- */

export const schema = {
  memorials,
  people,
  participants,
  magicTokens,
  mediaAssets,
  assetVariants,
  faceDetections,
  memoryNotes,
  lifeStoryDocs,
  interviewSessions,
  interviewTurns,
  slideshowProjects,
  musicTracks,
  musicSelections,
  renderJobs,
  eulogyDrafts,
  programDocs,
  jobs,
};

/** Physical table names, in creation order. Used by the migration smoke test. */
export const TABLE_NAMES = [
  'memorials',
  'people',
  'participants',
  'magic_tokens',
  'media_assets',
  'asset_variants',
  'face_detections',
  'memory_notes',
  'life_story_docs',
  'interview_sessions',
  'interview_turns',
  'slideshow_projects',
  'music_tracks',
  'music_selections',
  'render_jobs',
  'eulogy_drafts',
  'program_docs',
  'jobs',
] as const;

export type Memorial = typeof memorials.$inferSelect;
export type NewMemorial = typeof memorials.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type Participant = typeof participants.$inferSelect;
export type NewParticipant = typeof participants.$inferInsert;
export type MagicToken = typeof magicTokens.$inferSelect;
export type NewMagicToken = typeof magicTokens.$inferInsert;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
export type AssetVariant = typeof assetVariants.$inferSelect;
export type NewAssetVariant = typeof assetVariants.$inferInsert;
export type FaceDetection = typeof faceDetections.$inferSelect;
export type NewFaceDetection = typeof faceDetections.$inferInsert;
export type MemoryNote = typeof memoryNotes.$inferSelect;
export type NewMemoryNote = typeof memoryNotes.$inferInsert;
export type LifeStoryDocRow = typeof lifeStoryDocs.$inferSelect;
export type NewLifeStoryDocRow = typeof lifeStoryDocs.$inferInsert;
export type InterviewSession = typeof interviewSessions.$inferSelect;
export type NewInterviewSession = typeof interviewSessions.$inferInsert;
export type InterviewTurn = typeof interviewTurns.$inferSelect;
export type NewInterviewTurn = typeof interviewTurns.$inferInsert;
export type SlideshowProject = typeof slideshowProjects.$inferSelect;
export type NewSlideshowProject = typeof slideshowProjects.$inferInsert;
export type MusicTrack = typeof musicTracks.$inferSelect;
export type NewMusicTrack = typeof musicTracks.$inferInsert;
export type MusicSelection = typeof musicSelections.$inferSelect;
export type NewMusicSelection = typeof musicSelections.$inferInsert;
export type RenderJob = typeof renderJobs.$inferSelect;
export type NewRenderJob = typeof renderJobs.$inferInsert;
export type EulogyDraftRow = typeof eulogyDrafts.$inferSelect;
export type NewEulogyDraftRow = typeof eulogyDrafts.$inferInsert;
export type ProgramDocRow = typeof programDocs.$inferSelect;
export type NewProgramDocRow = typeof programDocs.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;

/** Re-exported so migration/bootstrap code can use raw SQL without a second import. */
export { sql };
