// Platform adapter for Cloudflare Worker modules (the
// `export default { async fetch(request, env, ctx) { ... } }` shape).
// Staged into the build directory by the platform; never part of the
// repository.
//
// Usage: node [--experimental-strip-types] .hive-worker-launcher.mjs <entry>

import http from 'node:http';
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const entry = process.argv[2];
if (!entry) {
  console.error('[hive-worker-launcher] missing entry argument');
  process.exit(1);
}

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('[hive-worker-launcher] PORT is not a valid port number');
  process.exit(1);
}

const IMPORT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = (() => {
  const value = Number(process.env.HIVE_MAX_DURATION_MS);
  return Number.isFinite(value) && value > 0 ? value : 300_000;
})();
const MAX_BODY_BYTES = 4_500_000;
const MAX_RESPONSE_BYTES = 4_500_000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function unwrapDefault(value) {
  let current = value;
  for (let i = 0; i < 5; i += 1) {
    if (current && typeof current === 'object' && current.default) {
      current = current.default;
    } else {
      break;
    }
  }
  return current;
}

let moduleNamespace;
try {
  moduleNamespace = await withTimeout(
    import(pathToFileURL(path.resolve(entry)).href),
    IMPORT_TIMEOUT_MS,
    `worker module did not finish importing within ${IMPORT_TIMEOUT_MS}ms`,
  );
} catch (error) {
  console.error('[hive-worker-launcher] worker import failed:', error?.stack || error);
  process.exit(1);
}

const worker = unwrapDefault(moduleNamespace.default ?? moduleNamespace);
const fetchHandler =
  typeof worker === 'object' && worker !== null && typeof worker.fetch === 'function'
    ? worker.fetch.bind(worker)
    : typeof moduleNamespace.fetch === 'function'
      ? moduleNamespace.fetch
      : null;

if (!fetchHandler) {
  console.error('[hive-worker-launcher] worker exports no callable fetch handler');
  process.exit(1);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('request body exceeds 4500000 bytes'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function envBindings() {
  return { ...process.env };
}

const server = http.createServer(async (req, res) => {
  const waitUntilTasks = [];
  const ctx = {
    waitUntil(promise) {
      waitUntilTasks.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
  };

  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const request = new Request(`http://${req.headers.host || `127.0.0.1:${port}`}${req.url || '/'}`, {
      method: req.method,
      headers,
      body,
    });
    const response = await withTimeout(
      fetchHandler(request, envBindings(), ctx),
      REQUEST_TIMEOUT_MS,
      `worker request exceeded ${REQUEST_TIMEOUT_MS}ms`,
    );
    if (!(response instanceof Response)) throw new Error('worker fetch did not return a Response');

    const responseHeaders = {};
    for (const [name, value] of response.headers) responseHeaders[name] = value;
    res.writeHead(response.status, responseHeaders);
    let written = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        written += chunk.byteLength;
        if (written > MAX_RESPONSE_BYTES) throw new Error('response body exceeds 4500000 bytes');
        if (!res.write(Buffer.from(chunk))) await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (error) {
    console.error('[hive-worker-launcher] request failed:', error?.stack || error);
    if (!res.headersSent) res.writeHead(error?.statusCode || 500, { 'content-type': 'text/plain; charset=utf-8' });
    if (!res.writableEnded) res.end(String(error?.message || error));
  } finally {
    await Promise.allSettled(waitUntilTasks);
  }
});

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[hive-worker-launcher] listening on 0.0.0.0:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[hive-worker-launcher] unhandled rejection:', reason);
});
