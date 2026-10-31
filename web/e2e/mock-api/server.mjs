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

import { HOST, ORIGIN, ORIGINS, PORT, SECURITY_HEADERS, cookies, createSession, deviceOf, endSession, ipOf, isApiPath, json, readBody, sessionOf, sleep, xsrfOk } from './http.mjs';
import { consoleHub } from './hubs/console.mjs';
import { attachHubs } from './hubs/signalr.mjs';
import { terminalHub } from './hubs/terminal.mjs';
import { USER, directoryExists, listDir, minutesAgo, reset, snapshotCommitted, state } from './state.mjs';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web/browser');
const MAX_FILE_BYTES = 5 * 1024 * 1024; // the largest file the files API saves (docs/ARCHITECTURE.md, "Files API contract")
const ABSENT_VERSION = 'absent'; // the version of a file that does not exist: a save with it creates the file

// ---------- helpers ----------

const sessionTimes = (session) => ({
  expiresIn: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
  absoluteExpiresIn: Math.max(0, Math.round((session.absoluteExpiresAt - Date.now()) / 1000))
});

// A shortened SHA-1: the contract fixes only the version of a missing file (ABSENT_VERSION), the rest is opaque.
const version = (content) => crypto.createHash('sha1').update(content ?? '').digest('hex').slice(0, 12);

function gitFiles(repoPath) {
  const repo = state.repos.get(repoPath);
  const files = [];
  for (const [p, content] of state.files) {
    if (!p.startsWith(repoPath + '/')) continue;
    if (!repo.committed.has(p)) files.push({ path: p, status: 'untracked' });
    else if (repo.committed.get(p) !== content) files.push({ path: p, status: 'modified' });
  }
  for (const p of repo.committed.keys()) {
    if (!state.files.has(p)) files.push({ path: p, status: 'deleted' });
  }
  return files;
}

function repoSummary(repoPath) {
  const repo = state.repos.get(repoPath);
  return {
    name: repoPath.slice(repoPath.lastIndexOf('/') + 1),
    path: repoPath,
    branch: repo.branch,
    changes: gitFiles(repoPath).length,
    upstream: repo.upstream,
    ahead: repo.ahead,
    behind: repo.behind,
    lastCommit: repo.lastCommit
  };
}

/**
 * Clone URL: the same strict rule as in the frontend and in the backend contract
 * (docs/ARCHITECTURE.md, "Workspaces and git"). `null` when the URL is valid.
 */
function cloneUrlProblem(url) {
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)+\/?$/.test(url)) {
    return 'Invalid URL.';
  }
  try {
    const parsed = new URL(url);
    if (parsed.href !== url || parsed.username || parsed.password) return 'Invalid URL.';
  } catch {
    return 'Invalid URL.';
  }
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(cloneName(url)) ? null : 'Invalid directory name.';
}

/** Repository directory name: the last URL segment without `.git` (POST /api/repos/clone contract). */
const cloneName = (url) => url.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '');

const reposIn = (workspace) => [...state.repos.keys()].filter((p) => p.split('/')[0] === workspace);
const slug = (name) => name.trim().toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/** English plural of "commit" (docs/ARCHITECTURE.md, "Workspaces and git"): 1 commit, otherwise commits. */
const commitWord = (n) => (n === 1 ? 'commit' : 'commits');

/**
 * Search in files (docs/ARCHITECTURE.md, "Search API contract") over state.files, as the backend answers it: the same
 * checks, flags, limits, previews and order; a binary file (null) is skipped. JavaScript's RegExp stands in for .NET's,
 * and what .NET refuses without backtracking (lookarounds, backreferences, atomic groups, conditionals, \G) is 400.
 */
const SEARCH_MAX_TEXT = 1000;
const SEARCH_MAX_MATCHES = 2000;
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;

function search(body) {
  const text = (value) => value === undefined || value === null || (typeof value === 'string' && value.length <= SEARCH_MAX_TEXT);
  const flag = (value) => value === undefined || value === null || typeof value === 'boolean';
  if (typeof body?.query !== 'string' || body.query.length < 1 || !text(body.query) || typeof body.path !== 'string'
    || !text(body.include) || !text(body.exclude) || !flag(body.matchCase) || !flag(body.wholeWord) || !flag(body.regex)) {
    return [400];
  }
  const pattern = searchPattern(body.query, body);
  const include = globs(body.include);
  const exclude = globs(body.exclude);
  if (!pattern || include === false || exclude === false || (body.path !== '' && !isApiPath(body.path))) return [400];
  if (!directoryExists(body.path)) return [404];
  const prefix = body.path === '' ? '' : body.path + '/';
  const paths = [...state.files.keys()].filter((p) => p.startsWith(prefix) && state.files.get(p) !== null).sort(bySegments);
  const files = [];
  let matchCount = 0;
  let limit = null;
  for (const p of paths) {
    const relative = p.slice(prefix.length);
    const content = state.files.get(p);
    if (relative.split('/').includes('node_modules') || (include && !include(relative)) || (exclude && exclude(relative))) continue;
    if (Buffer.byteLength(content, 'utf8') > SEARCH_MAX_FILE_BYTES || content.includes('\u0000')) continue;
    const matches = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && !limit; i++) {
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      const found = [];
      pattern.lastIndex = 0;
      for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
        if (m[0].length === 0) {
          pattern.lastIndex++;
          continue;
        }
        if (matchCount === SEARCH_MAX_MATCHES) {
          limit = 'results';
          break;
        }
        found.push([m.index, m[0].length]);
        matchCount++;
      }
      if (found.length) matches.push(previewOf(line, i + 1, found));
    }
    if (matches.length) files.push({ path: p, matches });
    if (limit) break;
  }
  return [200, { files, matchCount, limit }];
}

function searchPattern(query, { matchCase, wholeWord, regex }) {
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  if (regex && /\(\?<?[=!]|\(\?>|\(\?\(|\\[1-9]|\\k<|\\G/.test(source)) return null;
  try {
    new RegExp(source, 'u');
    if (wholeWord) source = `\\b(?:${source})\\b`;
    return new RegExp(source, matchCase ? 'gu' : 'giu');
  } catch {
    return null;
  }
}

/** From at most 30 characters before the first match, without leading whitespace or half a character, at most 250. */
function previewOf(line, number, found) {
  const first = found[0][0];
  let cut = Math.max(0, first - 30);
  while (cut < first && /\s/.test(line[cut])) cut++;
  if (cut < first && /[\uDC00-\uDFFF]/.test(line[cut])) cut++;
  let length = Math.min(250, line.length - cut);
  if (length > 0 && cut + length < line.length && /[\uD800-\uDBFF]/.test(line[cut + length - 1])) length--;
  const ranges = found.map(([index, size]) => [Math.max(0, index - cut), Math.min(length, index + size - cut)]).filter(([s, e]) => s < e);
  return { line: number, column: first + 1, preview: line.slice(cut, cut + length), ranges };
}

/** Comma-separated globs as the backend reads them; null without one, false for ".." after the start. */
function globs(text) {
  const tests = [];
  for (const part of (text ?? '').split(',')) {
    let glob = part.trim().replace(/^\/+|\/+$/g, '');
    if (glob.startsWith('./')) glob = glob.slice(2);
    if (!glob) continue;
    const base = glob.includes('/') ? glob : `**/${glob}`;
    if (base.split('/').slice(1).includes('..')) return false;
    tests.push(globRegExp(base), globRegExp(`${base}/**/*`));
  }
  return tests.length ? (relative) => tests.some((re) => re.test(relative)) : null;
}

/** `*` within a name, `**` any depth; every other character literal, as in Microsoft.Extensions.FileSystemGlobbing. */
function globRegExp(glob) {
  const parts = glob.split('/');
  const source = parts
    .map((part, i) => {
      if (part === '**') return i === parts.length - 1 ? '.*' : '(?:[^/]+/)*';
      return part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + (i === parts.length - 1 ? '' : '/');
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** The backend's walk order: by name at each level, ordinal (UTF-16 units). */
function bySegments(a, b) {
  const [x, y] = [a.split('/'), b.split('/')];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

/** Repositories by name, ordinal and ignoring case, compared upper-cased like the backend's OrdinalIgnoreCase. */
function byName(a, b) {
  const [x, y] = [a, b].map((p) => p.slice(p.lastIndexOf('/') + 1).toUpperCase());
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The terminal theme (docs/ARCHITECTURE.md, "Terminal theme API contract") from the text of a pywal colors.json a test
 * set (/__test/terminal-theme), checked as the backend checks the file: at most 16 KiB, a JSON object, the 19 values
 * "#" and 6 hex digits, sent in lower case and nothing else. null: 204.
 */
const THEME_MAX_BYTES = 16 * 1024;

function terminalTheme(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > THEME_MAX_BYTES) return null;
  let file;
  try {
    file = JSON.parse(content);
  } catch {
    return null;
  }
  const section = (name) => {
    const value = file?.[name];
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  };
  const special = section('special');
  const colors = section('colors');
  if (!special || !colors) return null;
  const values = [special.background, special.foreground, special.cursor, ...Array.from({ length: 16 }, (_, i) => colors[`color${i}`])];
  if (!values.every((value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value))) return null;
  const [background, foreground, cursor, ...palette] = values.map((value) => value.toLowerCase());
  return { background, foreground, cursor, palette };
}

/** Passkeys (docs/ARCHITECTURE.md, "Authentication" → "Passkeys"): the backend's limits and texts; no signature is checked. */
const PASSKEY_LIMIT = 10;
const PASSKEY_FRESH_MS = 5 * 60_000;
const PASSKEY_NAME_RULE = 'A passkey name has 1 to 64 characters and no control characters.';
const PASSKEY_NOT_ADDED = 'The passkey could not be added. Try again.';
const PASSKEY_LIMIT_TEXT = 'There are 10 passkeys already. Remove one first.';
/** The owner's id in the mock: the passkeys' user handle. */
const USER_ID = 'mock-owner';
const base64url = (data) => Buffer.from(data).toString('base64url');

/** A passkey name as the backend takes it: trimmed, 1-64 UTF-16 units, no control or format characters; null otherwise. */
function passkeyName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed.length >= 1 && trimmed.length <= 64 && !/[\p{Cc}\p{Cf}]/u.test(trimmed) ? trimmed : null;
}

/** The decoded clientDataJSON of a credential, or null. */
function clientDataOf(credential) {
  try {
    return JSON.parse(Buffer.from(credential?.response?.clientDataJSON ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

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

  // test control
  if (url.pathname === '/__test/reset') {
    reset();
    snapshotCommitted();
    json(res, 204);
    return;
  }
  if (url.pathname === '/__test/session-timeout') {
    // Shortens the inactivity timeout (also for existing sessions), so the countdown test does not wait 30 minutes.
    state.idleSeconds = Number(url.searchParams.get('idle') ?? 1800);
    for (const session of state.sessions.values()) session.expiresAt = Date.now() + state.idleSeconds * 1000;
    json(res, 204);
    return;
  }
  if (url.pathname === '/__test/kill-sessions') {
    state.sessions.clear();
    // keepSockets=1: the session is invalidated, but open WebSockets stay (a test of the HTTP interceptor alone).
    if (url.searchParams.get('keepSockets') !== '1') {
      for (const socket of [...state.sockets, ...state.terminalSockets]) socket.terminate();
    }
    json(res, 204);
    return;
  }
  if (url.pathname === '/__test/state') {
    const terminals = [...state.terminals.values()].map(({ id, title, cwd, exited, inputs, sizes }) => ({ id, title, cwd, exited, inputs, sizes }));
    json(res, 200, { files: Object.fromEntries(state.files), log: state.log, prompts: state.prompts, terminals, passkeyCount: state.passkeys.length, registrationCount: state.registrations.size, freshCount: state.freshUntil.size, challengeCount: state.challenges.size });
    return;
  }
  if (url.pathname === '/__test/file' && req.method === 'PUT') {
    const body = await readBody(req);
    state.files.set(body.path, body.content);
    json(res, 204);
    return;
  }
  if (url.pathname === '/__test/terminal-theme' && req.method === 'PUT') {
    // A pywal colors.json as text for GET /api/terminal/theme (null: none, as after a reset).
    const body = await readBody(req);
    state.terminalThemeFile = typeof body?.content === 'string' ? body.content : null;
    json(res, 204);
    return;
  }
  if (url.pathname === '/__test/repo-state' && req.method === 'POST') {
    // A test's own ahead/behind for a repository, so it does not have to add a fourth repository (which would move
    // the list other tests pin) to get a push rejection or a diverged pull.
    const body = await readBody(req);
    const repo = body && state.repos.get(body.repo);
    if (!repo) return json(res, 400);
    if (typeof body.ahead === 'number') repo.ahead = body.ahead;
    if (typeof body.behind === 'number') repo.behind = body.behind;
    json(res, 204);
    return;
  }
  if (url.pathname === '/__test/drop-sockets') {
    // Dropped connections without ending the session (e.g. a brief network failure): the client reconnects.
    for (const socket of [...state.sockets, ...state.terminalSockets]) socket.terminate();
    json(res, 204);
    return;
  }
  if (url.pathname === '/__test/fault') {
    // dropInputAck=N: the server accepts the next N `Input` batches, but drops the connection instead of acknowledging.
    // attachDelayMs: delay of the response to `Attach`.
    // hubDownMs: from now on, for this many ms the hubs reject new connections and open ones are dropped (network failure).
    // downAfterDropMs: after a drop caused by dropInputAck the hubs are unavailable for this many ms (a longer failure).
    // listDelayMs: delay of the response to `ListTerminals`.
    for (const key of Object.keys(state.faults)) {
      if (url.searchParams.has(key)) state.faults[key] = Number(url.searchParams.get(key));
    }
    if (url.searchParams.has('hubDownMs')) {
      state.hubDownUntil = Date.now() + state.faults.hubDownMs;
      for (const socket of [...state.sockets, ...state.terminalSockets]) socket.terminate();
    }
    json(res, 204);
    return;
  }

  // authentication
  if (url.pathname === '/api/auth/me') {
    const token = crypto.randomUUID();
    state.xsrfTokens.set(token, session?.id ?? null);
    res.setHeader('Set-Cookie', `XSRF-TOKEN=${token}; Path=/; SameSite=Strict`);
    session ? json(res, 200, { userName: session.userName, sessionId: session.id, ...sessionTimes(session) }) : json(res, 401);
    return;
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const ok = xsrfOk(req);
    const body = await readBody(req);
    state.log.push({ path: url.pathname, xsrf: ok });
    if (!ok) return json(res, 400);
    if (state.loginFailures >= 3) return json(res, 429, undefined, { 'Retry-After': '30' });
    const attempt = { at: new Date().toISOString(), ip: ipOf(req), device: deviceOf(req), method: 'password' };
    if (body?.userName !== USER.userName || body?.password !== USER.password || body?.totpCode !== USER.totpCode) {
      state.loginFailures++;
      state.logins.unshift({ ...attempt, success: false });
      return json(res, 401);
    }
    state.logins.unshift({ ...attempt, success: true });
    const sid = createSession(req);
    return json(res, 204, undefined, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Strict` });
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const ok = xsrfOk(req);
    const body = await readBody(req);
    state.log.push({ path: url.pathname, xsrf: ok, hadSession: !!session, sessionId: body?.sessionId });
    if (!ok) return json(res, 400);
    if (!session) return json(res, 401);
    // Logout of a specific session: the cookie already belongs to another one (a new login), so we end nothing.
    if (body?.sessionId && body.sessionId !== session.id) return json(res, 409);
    endSession(cookies(req).sid);
    return json(res, 204, undefined, {
      // Deliberately without Clear-Site-Data: Chrome can then hold the response for several seconds
      // (especially with a second open tab). The frontend clears storage, the API has no-store.
      'Set-Cookie': ['sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict', 'XSRF-TOKEN=; Path=/; Max-Age=0; SameSite=Strict']
    });
  }

  // re-authentication and the account's passkeys
  if (url.pathname === '/api/auth/reauthenticate' && req.method === 'POST') {
    if (!session) return json(res, 401);
    if (!xsrfOk(req)) return json(res, 400);
    const body = await readBody(req).catch(() => null);
    if (state.loginFailures >= 3) return json(res, 429, undefined, { 'Retry-After': '30' });
    if (body?.password !== USER.password || body?.totpCode !== USER.totpCode) {
      state.loginFailures++;
      state.logins.unshift({ at: new Date().toISOString(), ip: ipOf(req), device: deviceOf(req), success: false, method: 'password' });
      return json(res, 403);
    }
    state.freshUntil.set(cookies(req).sid, Date.now() + PASSKEY_FRESH_MS);
    return json(res, 204);
  }
  // the passkey login, anonymous like /api/auth/login
  if ((url.pathname === '/api/auth/passkeys/login-options' || url.pathname === '/api/auth/passkeys/login') && req.method === 'POST') {
    const ok = xsrfOk(req);
    const body = await readBody(req).catch(() => null);
    state.log.push({ path: url.pathname, xsrf: ok });
    if (!ok) return json(res, 400);
    if (state.loginFailures >= 3) return json(res, 429, undefined, { 'Retry-After': '30' });
    if (url.pathname === '/api/auth/passkeys/login-options') {
      const id = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.randomBytes(32));
      state.challenges.set(id, challenge);
      return json(res, 200, { challenge, timeout: 300000, rpId: 'localhost', allowCredentials: [], userVerification: 'required' },
        { 'Set-Cookie': `passkey=${id}; Path=/; Max-Age=300; HttpOnly; SameSite=Strict` });
    }
    const challengeId = cookies(req).passkey;
    const challenge = challengeId ? state.challenges.get(challengeId) : undefined;
    if (challengeId) state.challenges.delete(challengeId);
    const expire = 'passkey=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict';
    const credential = body?.credential;
    const clientData = clientDataOf(credential);
    const authenticatorData = Buffer.from(credential?.response?.authenticatorData ?? '', 'base64url');
    const rpIdHash = crypto.createHash('sha256').update('localhost').digest();
    const attempt = { at: new Date().toISOString(), ip: ipOf(req), device: deviceOf(req), method: 'passkey' };
    if (!challenge || clientData?.type !== 'webauthn.get' || clientData.challenge !== challenge || !ORIGINS.includes(clientData.origin)
      || !state.passkeys.some((p) => p.id === credential?.id) || credential.response?.userHandle !== base64url(USER_ID)
      || authenticatorData.length < 37 || !authenticatorData.subarray(0, 32).equals(rpIdHash) || (authenticatorData[32] & 0x04) === 0) {
      state.loginFailures++;
      state.logins.unshift({ ...attempt, success: false });
      return json(res, 401, undefined, { 'Set-Cookie': expire });
    }
    state.logins.unshift({ ...attempt, success: true });
    const sid = createSession(req);
    return json(res, 204, undefined, { 'Set-Cookie': [`sid=${sid}; Path=/; HttpOnly; SameSite=Strict`, expire] });
  }
  if (url.pathname === '/api/auth/passkeys' || url.pathname.startsWith('/api/auth/passkeys/')) {
    if (!session) return json(res, 401);
    if (req.method !== 'GET' && !xsrfOk(req)) return json(res, 400);
    const sid = cookies(req).sid;
    const fresh = (state.freshUntil.get(sid) ?? 0) > Date.now();
    if (url.pathname === '/api/auth/passkeys' && req.method === 'GET') return json(res, 200, state.passkeys);
    if (url.pathname === '/api/auth/passkeys/creation-options' && req.method === 'POST') {
      if (!fresh) return json(res, 403);
      if (state.passkeys.length >= PASSKEY_LIMIT) return json(res, 409, { message: PASSKEY_LIMIT_TEXT });
      const challenge = base64url(crypto.randomBytes(32));
      state.registrations.set(sid, challenge);
      return json(res, 200, {
        rp: { name: 'localhost', id: 'localhost' },
        user: { id: base64url(USER_ID), name: USER.userName, displayName: USER.userName },
        challenge,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: 300000,
        excludeCredentials: state.passkeys.map((p) => ({ type: 'public-key', id: p.id, transports: [] })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
    }
    if (url.pathname === '/api/auth/passkeys' && req.method === 'POST') {
      const body = await readBody(req).catch(() => null);
      const credential = body?.credential;
      if (typeof credential !== 'object' || credential === null) return json(res, 400, { message: PASSKEY_NOT_ADDED });
      const given = body.name;
      const blank = given === undefined || given === null || (typeof given === 'string' && given.trim() === '');
      const name = blank ? deviceOf(req) : passkeyName(given);
      if (!name) return json(res, 400, { message: PASSKEY_NAME_RULE });
      const challenge = state.registrations.get(sid);
      state.registrations.delete(sid);
      if (!challenge) return json(res, 400, { message: PASSKEY_NOT_ADDED });
      if (state.passkeys.length >= PASSKEY_LIMIT) return json(res, 409, { message: PASSKEY_LIMIT_TEXT });
      const clientData = clientDataOf(credential);
      const authenticatorData = Buffer.from(credential.response?.authenticatorData ?? '', 'base64url');
      if (clientData?.type !== 'webauthn.create' || clientData.challenge !== challenge || !ORIGINS.includes(clientData.origin)
        || typeof credential.id !== 'string' || !credential.id || state.passkeys.some((p) => p.id === credential.id)
        || authenticatorData.length < 37) {
        return json(res, 400, { message: PASSKEY_NOT_ADDED });
      }
      const passkey = { id: credential.id, name, createdAt: new Date().toISOString(), synced: (authenticatorData[32] & 0x08) !== 0 };
      state.passkeys.push(passkey);
      return json(res, 201, passkey);
    }
    const match = url.pathname.match(/^\/api\/auth\/passkeys\/([^/]+)$/);
    const passkey = match ? state.passkeys.find((p) => p.id === decodeURIComponent(match[1])) : undefined;
    if (match && req.method === 'PATCH') {
      const name = passkeyName((await readBody(req).catch(() => null))?.name);
      if (!name) return json(res, 400, { message: PASSKEY_NAME_RULE });
      if (!passkey) return json(res, 404);
      passkey.name = name;
      return json(res, 204);
    }
    if (match && req.method === 'DELETE') {
      if (!fresh) return json(res, 403);
      if (!passkey) return json(res, 404);
      state.passkeys = state.passkeys.filter((p) => p !== passkey);
      return json(res, 204);
    }
    return json(res, 404);
  }

  // extending the session, session list, login history
  if (url.pathname === '/api/auth/keepalive' && req.method === 'POST') {
    if (!session) return json(res, 401);
    if (!xsrfOk(req)) return json(res, 400);
    session.expiresAt = Date.now() + state.idleSeconds * 1000;
    session.lastActivityAt = new Date().toISOString();
    state.log.push({ path: 'keepalive' });
    return json(res, 200, { sessionId: session.id, ...sessionTimes(session) });
  }
  if (url.pathname.startsWith('/api/auth/sessions') || url.pathname === '/api/auth/logins') {
    if (!session) return json(res, 401);
    if (req.method !== 'GET' && !xsrfOk(req)) return json(res, 400);
    const currentSid = cookies(req).sid;
    if (url.pathname === '/api/auth/logins' && req.method === 'GET') return json(res, 200, state.logins.slice(0, 20));
    if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
      return json(res, 200, [...state.sessions].reverse().map(([sid, s]) => ({
        id: s.id, current: sid === currentSid, device: s.device, ip: s.ip, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt
      })));
    }
    if (url.pathname === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
      for (const sid of [...state.sessions.keys()]) if (sid !== currentSid) endSession(sid);
      state.log.push({ path: 'revoke-others' });
      return json(res, 204);
    }
    const match = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (match && req.method === 'DELETE') {
      const entry = [...state.sessions].find(([, s]) => s.id === decodeURIComponent(match[1]));
      if (!entry) return json(res, 404);
      if (entry[0] === currentSid) return json(res, 400, { message: 'Your own session ends with a logout.' });
      endSession(entry[0]);
      state.log.push({ path: 'revoke', id: entry[1].id });
      return json(res, 204);
    }
    return json(res, 404);
  }

  // workspaces and git
  if (['/api/workspaces', '/api/repos', '/api/repos/clone'].includes(url.pathname) || url.pathname.startsWith('/api/git/')) {
    if (!session) return json(res, 401);
    if (req.method !== 'GET' && !xsrfOk(req)) return json(res, 400, { message: 'Missing XSRF token.' });

    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      return json(res, 200, [...state.workspaces].map(([p, name]) => ({ name, path: p, repoCount: reposIn(p).length })));
    }
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      const { name } = (await readBody(req)) ?? {};
      state.log.push({ path: 'create-workspace', name });
      if (typeof name !== 'string' || !/^[\p{L}\p{N} _-]{1,40}$/u.test(name.trim()) || !slug(name)) {
        return json(res, 400, { message: 'Invalid name.' });
      }
      const p = slug(name);
      if (state.workspaces.has(p)) return json(res, 409, { message: 'Workspace already exists.' });
      state.workspaces.set(p, name.trim());
      return json(res, 201, { name: name.trim(), path: p, repoCount: 0 });
    }
    if (url.pathname === '/api/repos' && req.method === 'GET') {
      const ws = url.searchParams.get('workspace');
      if (!isApiPath(ws, 1)) return json(res, 400);
      if (!state.workspaces.has(ws)) return json(res, 404);
      return json(res, 200, reposIn(ws).sort(byName).map(repoSummary));
    }
    if (url.pathname === '/api/repos/clone' && req.method === 'POST') {
      const { workspace, url: remote } = (await readBody(req)) ?? {};
      state.log.push({ path: 'clone', workspace, url: remote });
      if (!isApiPath(workspace, 1)) return json(res, 400);
      if (!state.workspaces.has(workspace)) return json(res, 404);
      const problem = cloneUrlProblem(remote);
      if (problem) return json(res, 400, { message: problem });
      await sleep(300);
      const name = cloneName(remote);
      const repoPath = `${workspace}/${name}`;
      if (state.repos.has(repoPath)) return json(res, 409, { message: 'Directory already exists.' });
      if (remote.includes('nie-istnieje')) {
        return json(res, 502, { message: `remote: Repository not found.\nfatal: repository '${remote}' not found` });
      }
      state.files.set(`${repoPath}/README.md`, `# ${name}\n`);
      state.repos.set(repoPath, {
        branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0,
        lastCommit: { message: 'Initial commit', date: minutesAgo(60 * 24 * 30) },
        committed: new Map([[`${repoPath}/README.md`, `# ${name}\n`]])
      });
      return json(res, 201, repoSummary(repoPath));
    }

    const gitMethods = { '/api/git/show': 'GET', '/api/git/status': 'GET', '/api/git/pull': 'POST', '/api/git/push': 'POST' };
    if (gitMethods[url.pathname] !== req.method) return json(res, 404);
    const repoPath = url.searchParams.get('repo');
    const file = url.searchParams.get('path');
    const isShow = url.pathname === '/api/git/show';
    if (!isApiPath(repoPath, 2) || (isShow && !(isApiPath(file) && file.startsWith(repoPath + '/')))) return json(res, 400);
    const repo = state.repos.get(repoPath);
    if (!repo) return json(res, 404);
    if (isShow) {
      if (!repo.committed.has(file)) return json(res, 404);
      // A binary file (null in the mock) is 415, as in the files API.
      const content = repo.committed.get(file);
      return content === null ? json(res, 415) : json(res, 200, { content });
    }
    if (url.pathname === '/api/git/status' && req.method === 'GET') {
      return json(res, 200, { branch: repo.branch, ahead: repo.ahead, behind: repo.behind, files: gitFiles(repoPath) });
    }
    if (url.pathname === '/api/git/pull' && req.method === 'POST') {
      state.log.push({ path: 'pull', repo: repoPath });
      await sleep(150);
      if (!repo.upstream) return json(res, 400, { message: 'The branch has no upstream.' });
      if (repo.behind === 0 || !repo.remote) return json(res, 200, { message: 'Already up to date.', changedPaths: [] });
      // Diverged (ahead and behind both non-zero): not a fast-forward, as the backend's `git merge --ff-only` answers.
      if (repo.ahead > 0) {
        return json(res, 409, { message: `fatal: Not possible to fast-forward, aborting.` });
      }
      const incoming = Object.keys(repo.remote.files);
      const blocked = incoming.filter((p) => state.files.get(p) !== repo.committed.get(p));
      if (blocked.length) {
        return json(res, 409, { message: `error: Your local changes to the following files would be overwritten by merge:\n\t${blocked.join('\n\t')}` });
      }
      for (const [p, content] of Object.entries(repo.remote.files)) {
        state.files.set(p, content);
        repo.committed.set(p, content);
      }
      repo.lastCommit = { message: repo.remote.message, date: new Date().toISOString() };
      repo.remote = null;
      const pulled = repo.behind;
      repo.behind = 0;
      return json(res, 200, { message: `Pulled ${pulled} ${commitWord(pulled)}.`, changedPaths: incoming });
    }
    if (url.pathname === '/api/git/push' && req.method === 'POST') {
      state.log.push({ path: 'push', repo: repoPath });
      await sleep(150);
      if (!repo.upstream) return json(res, 400, { message: "No remote 'origin'." });
      // Nothing ahead: nothing to push, without the network, whatever "behind" is (the contract's rule).
      if (repo.ahead === 0) return json(res, 200, { message: 'Nothing to push.' });
      // Ahead and behind both non-zero: the remote has newer commits too, so the push is [rejected].
      if (repo.behind > 0) return json(res, 409, { message: ` ! [rejected]        ${repo.branch} -> ${repo.branch} (fetch first)` });
      const pushed = repo.ahead;
      repo.ahead = 0;
      return json(res, 200, { message: `Pushed ${pushed} ${commitWord(pushed)} to ${repo.upstream}.` });
    }
    return json(res, 404);
  }

  // search in files
  if (url.pathname === '/api/search' && req.method === 'POST') {
    if (!session) return json(res, 401);
    const ok = xsrfOk(req);
    const body = await readBody(req);
    state.log.push({ path: 'search', xsrf: ok });
    if (!ok) return json(res, 400);
    const [status, result] = search(body);
    return json(res, status, result);
  }

  // the terminal's colours (a GET: no XSRF token, as in the backend)
  if (url.pathname === '/api/terminal/theme' && req.method === 'GET') {
    if (!session) return json(res, 401);
    const theme = terminalTheme(state.terminalThemeFile);
    return theme ? json(res, 200, theme) : json(res, 204);
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
