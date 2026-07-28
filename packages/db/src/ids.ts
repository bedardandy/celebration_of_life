import { randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

/**
 * UUIDv7: time-ordered, so it indexes and paginates like a sequence while still
 * being safe to generate anywhere. Portable to Postgres unchanged.
 */
export function newId(): string {
  return uuidv7();
}

/** Escape hatch for the rare place that wants a non-time-ordered id. */
export function newRandomId(): string {
  return randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
