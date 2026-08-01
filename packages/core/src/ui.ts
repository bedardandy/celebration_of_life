/**
 * The handful of domain constants the browser also needs.
 *
 * Kept apart from the main entry point on purpose: `@col/core` reaches the
 * database and `node:crypto`, so a client component importing it would drag all
 * of that into the browser bundle (and fail the build, which is the good
 * outcome). Import `@col/core/ui` from anything marked 'use client'.
 */

/** Seconds the Undo offer stays on screen. Long enough to read and react. */
export const UNDO_WINDOW_SEC = 8;

/** Product name, in one place, so copy changes do not require a grep. */
export const PRODUCT_NAME = 'Celebration of Life';

/** The promise, in one sentence. Used as the landing headline and as <meta>. */
export const PRODUCT_TAGLINE =
  'A gentle way to gather photos, memories, and music for a celebration of life.';

/**
 * The read-aloud timer's arithmetic, which runs in the browser: the timer
 * component owns the clock, this owns the maths, and both halves are the same
 * code the server uses so a length can never be quoted two different ways.
 * Nothing in here touches the database.
 */
export * from './eulogy/timer';
