/**
 * How photographs reach the render browser.
 *
 * Remotion renders by driving a headless Chromium, and that browser is a
 * browser: it will not open `file://` URLs from a page served over http, quite
 * correctly. So the pictures have to arrive over HTTP, and there are two ways
 * to do that.
 *
 * The first — inlining every photograph as a `data:` URI in the input props —
 * is what the micro-render test does, and it is the wrong answer here. A real
 * tribute is sixty to eighty photographs at 2400px; base64 makes each about a
 * third bigger, and the whole lot has to be serialised into the page's props,
 * parsed by the browser, and held in memory for the entire render. Somewhere
 * around thirty megabytes that stops being slow and starts being a crash.
 *
 * The second is this: a one-line HTTP server on the loopback interface serving
 * exactly the files the render needs, from a scratch directory, for exactly as
 * long as the render takes. The browser streams and evicts images as it goes,
 * memory stays flat whether there are six photographs or six hundred, and
 * nothing is exposed — the socket is bound to 127.0.0.1, the port is whatever
 * the kernel gives us, and every request is checked against an allowlist built
 * from the render's own asset map rather than against a path prefix.
 */
import { createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
};

export type AssetServer = {
  /** assetId → the URL the composition should use. */
  urls: Record<string, string>;
  origin: string;
  close: () => Promise<void>;
};

/**
 * Serve exactly these files, and nothing else, for the life of one render.
 *
 * `files` maps an asset id to an absolute path already on disk. The route is
 * `/a/<assetId>`, so a path never appears in a URL and there is no traversal to
 * defend against: an id that is not in the map is a 404 regardless of what it
 * spells.
 */
export async function startAssetServer(files: Record<string, string>): Promise<AssetServer> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const id = decodeURIComponent(url.pathname.replace(/^\/a\//, ''));
    const file = files[id];

    if (!file) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    void stat(file)
      .then((info) => {
        response.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(info.size),
          // Rendering revisits the same photograph on every frame it is on
          // screen; letting the browser keep it is most of why this is fast.
          'cache-control': 'public, max-age=3600',
        });
        createReadStream(file).pipe(response);
      })
      .catch(() => {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const urls: Record<string, string> = {};
  for (const id of Object.keys(files)) urls[id] = `${origin}/a/${encodeURIComponent(id)}`;

  return {
    urls,
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
