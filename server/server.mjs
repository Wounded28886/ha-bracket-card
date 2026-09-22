#!/usr/bin/env node
/*
 * Standalone bracket server — the same cards, without Home Assistant.
 *
 * It serves the built card bundle plus a small page that fakes the two things
 * the cards ask Home Assistant for: a text entity holding the tournament, and
 * the pair of rest_commands that write and read results. Those land in one
 * JSON file on disk, so a container with a single volume is the whole
 * deployment. No database, no dependencies beyond Node itself.
 *
 * Environment:
 *   PORT       (8099)          port to listen on
 *   DATA_DIR   (/data)         where store.json lives
 *   TITLE      (Game Night)    heading on the page
 *   BOARD      (default)       board name when the URL doesn't name one
 *   POLL_MS    (25000)         how long a sync request may wait
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8099);
const DATA_DIR = process.env.DATA_DIR || '/data';
const TITLE = process.env.TITLE || 'Game Night';
const BOARD = process.env.BOARD || 'default';
const POLL_MS = Number(process.env.POLL_MS || 25000);
const MAX_BODY = 1024 * 1024;

const store = new Store(DATA_DIR);

// The card bundle lives in dist/ in the repo and next to the page in the
// image; look in both so `node server/server.mjs` works from a checkout.
const STATIC_ROOTS = [join(HERE, 'public'), join(HERE, '..', 'dist')];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(url, res) {
  const rel = normalize(decodeURIComponent(url === '/' ? '/index.html' : url)).replace(/^([/\\.]+)/, '');
  for (const root of STATIC_ROOTS) {
    const file = join(root, rel);
    if (!file.startsWith(root)) continue;              // no climbing out of the roots
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'cache-control': rel === 'index.html' ? 'no-store' : 'max-age=60',
      });
      res.end(body);
      return true;
    } catch (e) { /* try the next root */ }
  }
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const board = url.searchParams.get('board') || BOARD;

  try {
    if (path === '/healthz') return json(res, 200, { ok: true, ...store.stats() });

    if (path === '/api/config') {
      return json(res, 200, { title: TITLE, board, poll_ms: POLL_MS, version: 1 });
    }

    // Current tournament. `rev` turns it into a long poll: the request waits
    // until another device changes the board, so screens stay in step.
    if (path === '/api/state' && req.method === 'GET') {
      const rev = url.searchParams.has('rev') ? Number(url.searchParams.get('rev')) : null;
      const cur = rev === null ? store.board(board) : await store.watch(board, rev, POLL_MS);
      return json(res, 200, { board, value: cur.value, rev: cur.rev, updated: cur.updated });
    }

    if (path === '/api/state' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.value !== 'string') return json(res, 400, { error: 'value must be a string' });
      const next = store.setBoard(body.board || board, body.value);
      return json(res, 200, { board: body.board || board, rev: next.rev });
    }

    // The InfluxDB-shaped pair the cards already speak.
    if (path === '/api/write' && req.method === 'POST') {
      const raw = await readBody(req);
      const line = (req.headers['content-type'] || '').includes('json')
        ? (JSON.parse(raw || '{}').line || '') : raw;
      try {
        const n = store.write(line);
        return json(res, 200, { written: n });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (path === '/api/query') {
      const q = req.method === 'GET'
        ? url.searchParams.get('q')
        : (JSON.parse((await readBody(req)) || '{}').q || '');
      if (!q) return json(res, 400, { error: 'q is required' });
      const out = store.query(q);
      const failed = out.results.find((r) => r.error);
      return json(res, failed ? 400 : 200, out);
    }

    if (req.method === 'GET' && await serveStatic(path, res)) return;
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) return json(res, 500, { error: e.message });
    res.end();
  }
});

server.listen(PORT, () => {
  const { port } = server.address();
  console.log(`bracket server listening on http://0.0.0.0:${port} — data in ${store.stats().file}`);
});

// Never leave a game night on the floor.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { store.flush(); } catch (e) { console.error('[store] final flush failed', e); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

export { server, store };
