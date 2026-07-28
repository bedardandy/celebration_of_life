import { z } from 'zod';
import { BeatGridSchema } from './edl';
import { SlugSchema } from './common';

/**
 * How a track came to be usable, and who is answerable for that.
 *
 * A commercial recording baked into a video the family then shares needs a
 * per-song synchronisation licence, which is not something this product can
 * obtain on anyone's behalf. So there are exactly three honest answers:
 *
 *  - public-domain   the composition and the recording are both out of copyright
 *  - royalty-free    we hold a licence that permits this use, named in licenseNote
 *  - family-supplied the family owns it, or it is theirs to use, and they said so
 *
 * Anything else does not get into the library, and there is no fourth value to
 * hide an unclear case in.
 */
export const LicenseKindSchema = z.enum(['public-domain', 'royalty-free', 'family-supplied']);
export type LicenseKind = z.infer<typeof LicenseKindSchema>;

/**
 * The four words a grieving family can actually choose between at 11pm.
 *
 * Deliberately not a genre taxonomy: nobody browsing music for their mother's
 * funeral wants to decide between "neo-classical" and "ambient piano". They
 * know whether they want the room calm, lifted, thoughtful, or held.
 */
export const MoodTagSchema = z.enum(['peaceful', 'hopeful', 'reflective', 'warm']);
export type MoodTag = z.infer<typeof MoodTagSchema>;

/**
 * `content/music-library/<slug>/meta.json`, validated at load.
 *
 * A track whose metadata does not parse is excluded from the library rather
 * than shipped half-known — a file we cannot describe the licence of is a file
 * we cannot let a family publish.
 */
export const MusicTrackMetaSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1).max(120),
    artist: z.string().min(1).max(120).optional(),
    durationSec: z.number().gt(0).max(3600),
    bpm: z.number().gt(0).max(400),
    licenseKind: LicenseKindSchema,
    /** Provenance in one paragraph: what the licence is, and where it came from. */
    licenseNote: z.string().min(1).max(1000),
    sourceUrl: z.string().max(500).optional(),
    /** ISO date, for the provenance trail. */
    acquiredAt: z.string().max(40).optional(),
    /** A person, not a system. Someone checked this. */
    verifiedBy: z.string().max(120).optional(),
    moodTags: z.array(MoodTagSchema).default([]),
    /** Traditions this track suits. Empty means no restriction. */
    traditionTags: z.array(SlugSchema).default([]),
    /** One quiet line the picker shows under the title. */
    description: z.string().max(300).optional(),
    /** Exact, because we synthesised the track and therefore know the tempo. */
    beatGrid: BeatGridSchema,
    /** File name inside the track directory, e.g. "audio.m4a". */
    audioFile: z.string().min(1).max(120).default('audio.m4a'),
    mime: z.string().min(1).max(80).default('audio/mp4'),
  })
  .strict();
export type MusicTrackMeta = z.infer<typeof MusicTrackMetaSchema>;
