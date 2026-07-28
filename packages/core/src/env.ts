/**
 * Environment resolution for the parts of the product that face a person.
 *
 * Two rules here. First, a missing variable never crashes a family's session in
 * development — we fall back and warn loudly on the server. Second, in
 * production a missing secret is a hard failure, because a session cookie that
 * anyone can forge is worse than an app that will not boot.
 */

export const DEV_SESSION_SECRET = 'dev-only-insecure-session-secret';

export function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

let warnedAboutSecret = false;

/**
 * Key used to sign the session cookie. Set `SESSION_SECRET` in production;
 * rotating it simply signs everyone out, which is a safe thing to do.
 */
export function sessionSecret(): string {
  const configured = process.env['SESSION_SECRET']?.trim();
  if (configured) return configured;
  if (isProduction()) {
    throw new Error(
      'SESSION_SECRET is not set. Set it to a long random string before running in production.',
    );
  }
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    process.emitWarning(
      'SESSION_SECRET is not set; using an insecure development default. Set SESSION_SECRET before deploying.',
    );
  }
  return DEV_SESSION_SECRET;
}

/** Only for tests, which need the "already warned" latch reset. */
export function resetEnvWarnings(): void {
  warnedAboutSecret = false;
}

/**
 * Base URL used to compose magic links. It has to be absolute: the link is read
 * in an email client, not in the browser tab that made it.
 */
export function appBaseUrl(): string {
  const configured = process.env['APP_BASE_URL']?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const port = process.env['PORT']?.trim() || '3000';
  return `http://localhost:${port}`;
}

export function absoluteUrl(pathname: string): string {
  return `${appBaseUrl()}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
