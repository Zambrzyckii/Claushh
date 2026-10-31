// Mock backend for e2e tests: serves the built frontend (dist/web/browser) and implements the contracts
// from docs/ARCHITECTURE.md (authentication, files, search, the terminal theme, workspaces and git, the console hub in the SignalR JSON protocol
// over WebSocket, the terminal hub with a simple simulated shell). Instead of the real Claude Code it replays short
// scripts that depend on the prompt text.
// Git is simulated: the "committed" file content is their state at reset, and status is the difference from it.
//
// For tests only. The /__test/* endpoints let tests reset and inspect the state, so the server listens
// only on 127.0.0.1. Started by Playwright (playwright.config.ts → webServer).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST, ORIGIN, PORT, SECURITY_HEADERS, json, readBody, sessionOf, xsrfOk } from './http.mjs';
import { consoleHub } from './hubs/console.mjs';
import { attachHubs } from './hubs/signalr.mjs';
import { terminalHub } from './hubs/terminal.mjs';
import { authRoutes } from './routes/auth.mjs';
import { passkeyRoutes } from './routes/passkeys.mjs';
import { searchRoutes } from './routes/search.mjs';
import { terminalThemeRoutes } from './routes/terminal-theme.mjs';
import { testControlRoutes } from './routes/test-control.mjs';
import { workspaceRoutes } from './routes/workspaces.mjs';
import { directoryExists, listDir, state } from './state.mjs';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web/browser');
const MAX_FILE_BYTES = 5 * 1024 * 1024; // the largest file the files API saves (docs/ARCHITECTURE.md, "Files API contract")
const ABSENT_VERSION = 'absent'; // the version of a file that does not exist: a save with it creates the file

// ---------- helpers ----------

// A shortened SHA-1: the contract fixes only the version of a missing file (ABSENT_VERSION), the rest is opaque.
const version = (content) => crypto.createHash('sha1').update(content ?? '').digest('hex').slice(0, 12);

// ---------- HTTP ----------

// CSP is the policy from <meta> in index.html plus `frame-ancestors`, which cannot be set in <meta>.
function pageCsp() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  if (!meta) throw new Error('index.html has no CSP policy');
  return `${meta[1]}; frame-ancestors 'none'`;
}

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    await handle(req, res);
  } catch (error) {
    // A bad request (e.g. bad JSON, bad URL) must not bring down the test server.
    if (!res.headersSent) json(res, 400, { message: String(error?.message ?? error) });
    else res.end();
  }
});

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const session = sessionOf(req);

  for (const routes of [testControlRoutes, authRoutes, passkeyRoutes, workspaceRoutes, searchRoutes, terminalThemeRoutes]) {
    if (await routes(req, res, url, session)) return;
  }

  // files
  if (url.pathname.startsWith('/api/')) {
    if (!session) return json(res, 401);
    const p = url.searchParams.get('path') ?? '';
    if (p.startsWith('/') || p.split('/').includes('..')) return json(res, 400);
    if (url.pathname === '/api/files/list') {
      state.log.push({ path: 'list', p });
      return json(res, 200, listDir(p));
    }
    if (url.pathname === '/api/files/content' && req.method === 'GET') {
      if (!state.files.has(p)) return json(res, 404);
      if (state.files.get(p) === null) return json(res, 415);
      return json(res, 200, { path: p, content: state.files.get(p), version: version(state.files.get(p)) });
    }
    if (url.pathname === '/api/files/content' && req.method === 'PUT') {
      const ok = xsrfOk(req);
      const body = await readBody(req);
      state.log.push({ path: 'write', p, xsrf: ok });
      if (!ok) return json(res, 400);
      if (typeof body?.content !== 'string' || typeof body?.baseVersion !== 'string') return json(res, 400);
      // As in the backend: a file can only be saved in a directory that exists (a file is no directory), before any
      // content or version check.
      if (!directoryExists(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')) return json(res, 404);
      // As in the backend, whatever the version: text that a read would refuse, and more than 5 MB, is not saved.
      if (body.content.includes('\u0000')) return json(res, 415);
      if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) return json(res, 413);
      // Decided by the existence of the file, not by its content: a missing, an empty and a binary file hash alike.
      const current = state.files.has(p) ? version(state.files.get(p)) : ABSENT_VERSION;
      if (body.baseVersion !== current) return json(res, 409, { currentVersion: current });
      state.files.set(p, body.content);
      return json(res, 200, { version: version(body.content) });
    }
    return json(res, 404);
  }

  // frontend (SPA)
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };
  const headers = { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' };
  if (file.endsWith('index.html')) {
    headers['Cache-Control'] = 'no-store';
    headers['Content-Security-Policy'] = pageCsp();
    headers['X-Frame-Options'] = 'DENY';
  }
  res.writeHead(200, headers).end(fs.readFileSync(file));
}

// ---------- SignalR hubs (JSON protocol): console and terminal ----------

attachHubs(server, { '/hubs/console': consoleHub, '/hubs/terminal': terminalHub });

server.listen(PORT, HOST, () => console.log(`mock api on ${ORIGIN}`));
