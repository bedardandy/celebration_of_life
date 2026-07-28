/**
 * The service-date screen autosaves as its fields change, so its Continue
 * button must keep what is already stored rather than re-writing it. This
 * sentinel says "the answer is whatever autosave already put there".
 *
 * It lives in its own module because a 'use server' file may only export async
 * functions.
 */
export const KEEP = 'keep';
