/**
 * What the web app settles before it serves anything.
 *
 * Next calls this once per server process, before the first request. The only
 * thing that has to happen here is choosing the blob store: every call to
 * `getBlobStore()` in a route handler is synchronous, so the asynchronous part
 * of building an S3 client cannot happen inside one.
 *
 * A deployment on the default local disk store does no work here at all.
 */
export async function register(): Promise<void> {
  // Only the Node runtime touches storage; the edge runtime never serves blobs.
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { initBlobStore } = await import('@col/storage');
  await initBlobStore();
}
