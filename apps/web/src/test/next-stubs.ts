/**
 * Enough of Next's request context to run route handlers and server actions as
 * plain functions.
 *
 * Route handlers and server actions are the real code paths a person walks
 * through, so testing them directly is worth a small amount of faking: an
 * in-memory cookie jar, and a no-op for cache revalidation, which has nothing
 * to assert about anyway.
 */

export type StoredCookie = { name: string; value: string; options?: Record<string, unknown> };

export class CookieJar {
  private readonly jar = new Map<string, StoredCookie>();

  get(name: string): StoredCookie | undefined {
    return this.jar.get(name);
  }

  set(name: string, value: string, options?: Record<string, unknown>): void {
    this.jar.set(name, { name, value, options });
  }

  delete(name: string): void {
    this.jar.delete(name);
  }

  clear(): void {
    this.jar.clear();
  }

  /** Header value a browser would send back. */
  header(): string {
    return [...this.jar.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

export const cookieJar = new CookieJar();

/** Matches the shape `next/headers` returns, for the parts we use. */
export function nextHeadersMock() {
  return {
    cookies: async () => ({
      get: (name: string) => cookieJar.get(name),
      set: (name: string, value: string, options?: Record<string, unknown>) =>
        cookieJar.set(name, value, options),
      delete: (name: string) => cookieJar.delete(name),
    }),
  };
}

export function nextCacheMock() {
  return {
    revalidatePath: () => {},
    revalidateTag: () => {},
  };
}

/**
 * `redirect()` and `notFound()` work by throwing. This unwraps the throw into
 * the destination, so a test can read where a person was actually sent.
 */
export async function captureRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      // digest: NEXT_REDIRECT;<replace|push>;<url>;<status>;
      return digest.split(';')[2] ?? '';
    }
    throw error;
  }
  throw new Error('expected a redirect, but the call returned normally');
}
