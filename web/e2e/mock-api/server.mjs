// Mock backend for e2e tests: serves the built frontend (dist/web/browser) and implements the contracts
// from docs/ARCHITECTURE.md (authentication, files, workspaces and git, the console hub in the SignalR JSON protocol
// over WebSocket, the terminal hub with a simple simulated shell). Instead of the real Claude Code it replays short
// scripts that depend on the prompt text.
// Git is simulated: the "committed" file content is their state at reset, and status is the difference from it.
//
// For tests only. The /__test/* endpoints let tests reset and inspect the state.
// Started by Playwright (playwright.config.ts → webServer).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT ?? 4400);
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web/browser');
const ORIGIN = `http://localhost:${PORT}`;
const RS = '\x1e'; // message separator in the SignalR protocol

export const USER = { userName: 'owner', password: 'secret', totpCode: '123456' };
export const MAIN = 'studia/lab-3-sieci/src/main.c';

const INITIAL_FILES = {
  [MAIN]: '#include <stdio.h>\n\nint main(void)\n{\n    return 0;\n}\n',
  'studia/lab-3-sieci/src/parser.c': 'int parse(void)\n{\n    return 1;\n}\n',
  'studia/lab-3-sieci/Makefile': 'all:\n\tcc -o app src/main.c\n',
  'studia/lab-3-sieci/logo.png': null,
  'studia/so-projekt-shell/src/shell.c': 'int main(void) { return 0; }\n',
  'studia/bazy-danych-lab/zadanie4.sql': '-- zadanie 4\nCREATE VIEW v AS SELECT 1;\n',
  'prywatne/notatki/README.md': '# Notatki\n'
};

export const BAZY_SQL = 'studia/bazy-danych-lab/zadanie4.sql';

const INITIAL_WORKSPACES = [
  ['studia', 'Studia'],
  ['prywatne', 'Prywatne']
];

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function initialRepos() {
  return new Map([
    ['studia/lab-3-sieci', { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, lastCommit: { message: 'parser: szkielet parse_ipv4', date: minutesAgo(12) } }],
    ['studia/so-projekt-shell', { branch: 'dev', upstream: 'origin/dev', ahead: 0, behind: 0, lastCommit: { message: 'obsługa potoków', date: minutesAgo(2 * 1440) } }],
    ['studia/bazy-danych-lab', {
      branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2,
      lastCommit: { message: 'zadanie 4: widoki', date: minutesAgo(7 * 1440) },
      remote: { message: 'poprawki od prowadzącego', files: { [BAZY_SQL]: '-- zadanie 4 (poprawione)\nCREATE VIEW v AS SELECT 2;\n' } }
    }],
    ['prywatne/notatki', { branch: 'main', upstream: null, ahead: 0, behind: 0, lastCommit: { message: 'semestr 5', date: minutesAgo(3 * 1440) } }]
  ]);
}

let state;
function reset() {
  for (const socket of [...(state?.sockets ?? []), ...(state?.terminalSockets ?? [])]) socket.terminate();
  state = {
    sessions: new Map(), // sid (secret from the cookie) -> { id (public), userName, ip, device, createdAt, lastActivityAt, expiresAt, absoluteExpiresAt }
    idleSeconds: 30 * 60,
    absoluteSeconds: 12 * 3600,
    logins: [],
    loginFailures: 0,
    files: new Map(Object.entries(INITIAL_FILES)),
    workspaces: new Map(INITIAL_WORKSPACES),
    repos: initialRepos(),
    log: [],
    sockets: new Set(),
    terminalSockets: new Set(),
    terminals: new Map(), // id -> { id, title, cwd, exited, seq, history, line, inputs, sizes }
    terminalCounter: 0,
    conversations: new Map(), // id -> { projectPath, events, running }
    latestByProject: new Map(),
    prompts: []
  };
}
reset();

/** "Committed" state = repository file content at reset time (or after pull/clone). */
function snapshotCommitted() {
  for (const [repoPath, repo] of state.repos) {
    repo.committed = new Map([...state.files].filter(([p]) => p.startsWith(repoPath + '/')));
  }
}
snapshotCommitted();

// ---------- helpers ----------

const cookies = (req) =>
  Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
/** Session from the cookie. An expired one (inactivity or hard limit) is removed, as on the real server. */
function sessionOf(req) {
  const sid = cookies(req).sid;
  const session = state.sessions.get(sid);
  if (session && (Date.now() > session.expiresAt || Date.now() > session.absoluteExpiresAt)) {
    endSession(sid);
    return undefined;
  }
  return session;
}

function endSession(sid) {
  state.sessions.delete(sid);
  for (const ws of [...state.sockets, ...state.terminalSockets]) {
    if (ws.sid === sid) ws.terminate();
  }
}

const sessionTimes = (session) => ({
  expiresIn: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
  absoluteExpiresIn: Math.max(0, Math.round((session.absoluteExpiresAt - Date.now()) / 1000))
});

function deviceOf(req) {
  const ua = req.headers['user-agent'] ?? '';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrom/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Przeglądarka';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'nieznany system';
  return `${browser} · ${os}`;
}

const ipOf = (req) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
const xsrfOk = (req) => !!cookies(req)['XSRF-TOKEN'] && req.headers['x-xsrf-token'] === cookies(req)['XSRF-TOKEN'];
const version = (content) => crypto.createHash('sha1').update(content ?? '').digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data ? JSON.parse(data) : null));
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(body === undefined ? '' : JSON.stringify(body));
}

function listDir(dir) {
  const out = new Map();
  const add = (p, isDirectory) => {
    if (dir && !p.startsWith(dir + '/')) return;
    const rest = dir ? p.slice(dir.length + 1) : p;
    const [name, ...more] = rest.split('/');
    out.set(name, { name, path: dir ? `${dir}/${name}` : name, kind: more.length || isDirectory ? 'directory' : 'file' });
  };
  for (const p of state.files.keys()) add(p, false);
  for (const p of [...state.workspaces.keys(), ...state.repos.keys()]) add(p, true);
  return [...out.values()];
}

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

const reposIn = (workspace) => [...state.repos.keys()].filter((p) => p.split('/')[0] === workspace);
const slug = (name) => name.trim().toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
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
    json(res, 200, { files: Object.fromEntries(state.files), log: state.log, prompts: state.prompts, terminals });
    return;
  }
  if (url.pathname === '/__test/file' && req.method === 'PUT') {
    const body = await readBody(req);
    state.files.set(body.path, body.content);
    json(res, 204);
    return;
  }

  // authentication
  if (url.pathname === '/api/auth/me') {
    res.setHeader('Set-Cookie', `XSRF-TOKEN=${crypto.randomUUID()}; Path=/; SameSite=Strict`);
    session ? json(res, 200, { userName: session.userName, ...sessionTimes(session) }) : json(res, 401);
    return;
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const ok = xsrfOk(req);
    const body = await readBody(req);
    state.log.push({ path: url.pathname, xsrf: ok });
    if (!ok) return json(res, 400);
    if (state.loginFailures >= 3) return json(res, 429, undefined, { 'Retry-After': '30' });
    const attempt = { at: new Date().toISOString(), ip: ipOf(req), device: deviceOf(req) };
    if (body?.userName !== USER.userName || body?.password !== USER.password || body?.totpCode !== USER.totpCode) {
      state.loginFailures++;
      state.logins.unshift({ ...attempt, success: false });
      return json(res, 401);
    }
    state.logins.unshift({ ...attempt, success: true });
    const sid = crypto.randomUUID();
    const now = Date.now();
    state.sessions.set(sid, {
      id: crypto.randomUUID(),
      userName: USER.userName,
      ip: ipOf(req),
      device: deviceOf(req),
      createdAt: new Date(now).toISOString(),
      lastActivityAt: new Date(now).toISOString(),
      expiresAt: now + state.idleSeconds * 1000,
      absoluteExpiresAt: now + state.absoluteSeconds * 1000
    });
    return json(res, 204, undefined, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Strict` });
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const ok = xsrfOk(req);
    state.log.push({ path: url.pathname, xsrf: ok, hadSession: !!session });
    if (!ok) return json(res, 400);
    if (!session) return json(res, 401);
    endSession(cookies(req).sid);
    return json(res, 204, undefined, {
      // Deliberately without Clear-Site-Data: Chrome can then hold the response for several seconds
      // (especially with a second open tab). The frontend clears storage, the API has no-store.
      'Set-Cookie': ['sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict', 'XSRF-TOKEN=; Path=/; Max-Age=0; SameSite=Strict']
    });
  }

  // extending the session, session list, login history
  if (url.pathname === '/api/auth/keepalive' && req.method === 'POST') {
    if (!session) return json(res, 401);
    if (!xsrfOk(req)) return json(res, 400);
    session.expiresAt = Date.now() + state.idleSeconds * 1000;
    session.lastActivityAt = new Date().toISOString();
    state.log.push({ path: 'keepalive' });
    return json(res, 200, sessionTimes(session));
  }
  if (url.pathname.startsWith('/api/auth/sessions') || url.pathname === '/api/auth/logins') {
    if (!session) return json(res, 401);
    if (req.method !== 'GET' && !xsrfOk(req)) return json(res, 400);
    const currentSid = cookies(req).sid;
    if (url.pathname === '/api/auth/logins' && req.method === 'GET') return json(res, 200, state.logins.slice(0, 20));
    if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
      return json(res, 200, [...state.sessions].map(([sid, s]) => ({
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
      if (entry[0] === currentSid) return json(res, 400, { message: 'Własną sesję kończy się wylogowaniem.' });
      endSession(entry[0]);
      state.log.push({ path: 'revoke', id: entry[1].id });
      return json(res, 204);
    }
    return json(res, 404);
  }

  // workspaces and git
  if (['/api/workspaces', '/api/repos', '/api/repos/clone'].includes(url.pathname) || url.pathname.startsWith('/api/git/')) {
    if (!session) return json(res, 401);
    if (req.method !== 'GET' && !xsrfOk(req)) return json(res, 400, { message: 'Brak tokenu XSRF.' });

    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      return json(res, 200, [...state.workspaces].map(([p, name]) => ({ name, path: p, repoCount: reposIn(p).length })));
    }
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      const { name } = (await readBody(req)) ?? {};
      state.log.push({ path: 'create-workspace', name });
      if (typeof name !== 'string' || !/^[\p{L}\p{N} _-]{1,40}$/u.test(name.trim()) || !slug(name)) {
        return json(res, 400, { message: 'Nieprawidłowa nazwa.' });
      }
      const p = slug(name);
      if (state.workspaces.has(p)) return json(res, 409, { message: 'Workspace już istnieje.' });
      state.workspaces.set(p, name.trim());
      return json(res, 201, { name: name.trim(), path: p, repoCount: 0 });
    }
    if (url.pathname === '/api/repos' && req.method === 'GET') {
      const ws = url.searchParams.get('workspace') ?? '';
      if (!state.workspaces.has(ws)) return json(res, 404);
      return json(res, 200, reposIn(ws).map(repoSummary));
    }
    if (url.pathname === '/api/repos/clone' && req.method === 'POST') {
      const { workspace, url: remote } = (await readBody(req)) ?? {};
      state.log.push({ path: 'clone', workspace, url: remote });
      if (!state.workspaces.has(workspace)) return json(res, 404);
      let parsed;
      try {
        parsed = new URL(remote);
      } catch {
        return json(res, 400, { message: 'Nieprawidłowy adres.' });
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return json(res, 400, { message: 'Tylko https bez danych logowania.' });
      await sleep(300);
      const name = parsed.pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? '';
      if (!name) return json(res, 400, { message: 'Nie da się ustalić nazwy repozytorium.' });
      const repoPath = `${workspace}/${name}`;
      if (state.repos.has(repoPath)) return json(res, 409, { message: 'Katalog już istnieje.' });
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

    const repoPath = url.searchParams.get('repo') ?? '';
    const repo = state.repos.get(repoPath);
    if (!repo) return json(res, 404);
    if (url.pathname === '/api/git/show' && req.method === 'GET') {
      const file = url.searchParams.get('path') ?? '';
      if (!file.startsWith(repoPath + '/') || file.split('/').includes('..')) return json(res, 400);
      return repo.committed.has(file) && repo.committed.get(file) !== null
        ? json(res, 200, { content: repo.committed.get(file) })
        : json(res, 404);
    }
    if (url.pathname === '/api/git/status' && req.method === 'GET') {
      return json(res, 200, { branch: repo.branch, ahead: repo.ahead, behind: repo.behind, files: gitFiles(repoPath) });
    }
    if (url.pathname === '/api/git/pull' && req.method === 'POST') {
      state.log.push({ path: 'pull', repo: repoPath });
      await sleep(150);
      if (!repo.upstream) return json(res, 400, { message: 'Gałąź nie ma gałęzi zdalnej.' });
      if (repo.behind === 0 || !repo.remote) return json(res, 200, { message: 'Już aktualne.', changedPaths: [] });
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
      return json(res, 200, { message: `Pobrano ${pulled} commity.`, changedPaths: incoming });
    }
    if (url.pathname === '/api/git/push' && req.method === 'POST') {
      state.log.push({ path: 'push', repo: repoPath });
      await sleep(150);
      if (!repo.upstream) return json(res, 400, { message: "Brak zdalnego repozytorium 'origin'." });
      if (repo.behind > 0) return json(res, 409, { message: ` ! [rejected]        ${repo.branch} -> ${repo.branch} (fetch first)` });
      if (repo.ahead === 0) return json(res, 200, { message: 'Nic do wypchnięcia.' });
      const pushed = repo.ahead;
      repo.ahead = 0;
      return json(res, 200, { message: `Wypchnięto ${pushed} commit do ${repo.upstream}.` });
    }
    return json(res, 404);
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
      const current = version(state.files.get(p));
      if (body.baseVersion !== current) return json(res, 409, { currentVersion: current });
      state.files.set(p, body.content);
      return json(res, 200, { version: version(body.content) });
    }
    return json(res, 404);
  }

  // frontend (SPA)
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
  const headers = { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' };
  if (file.endsWith('index.html')) headers['Cache-Control'] = 'no-store';
  res.writeHead(200, headers).end(fs.readFileSync(file));
});

// ---------- SignalR hubs (JSON protocol): console and terminal ----------

const wss = new WebSocketServer({ noServer: true });
const HUBS = {
  '/hubs/console': { sockets: () => state.sockets, invoke: (target, args) => invoke(target, args) },
  '/hubs/terminal': { sockets: () => state.terminalSockets, invoke: (target, args) => invokeTerminal(target, args) }
};

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, ORIGIN);
  const hub = HUBS[url.pathname];
  if (!hub || !sessionOf(req) || req.headers.origin !== ORIGIN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sid = cookies(req).sid; // so that ending the session closes its connections
    onConnection(ws, hub);
  });
});

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message) + RS);
}

function broadcast(event) {
  const conversation = state.conversations.get(event.conversationId);
  conversation?.events.push(event);
  for (const ws of state.sockets) send(ws, { type: 1, target: 'ConsoleEvent', arguments: [event] });
}

function onConnection(ws, hub) {
  let handshake = false;
  const sockets = hub.sockets();
  const ping = setInterval(() => send(ws, { type: 6 }), 5000);
  ws.on('close', () => {
    clearInterval(ping);
    sockets.delete(ws);
  });
  ws.on('message', async (raw) => {
    for (const part of raw.toString().split(RS).filter(Boolean)) {
      const message = JSON.parse(part);
      if (!handshake) {
        handshake = true;
        sockets.add(ws);
        ws.send('{}' + RS);
        continue;
      }
      if (message.type !== 1) continue;
      let result = null;
      let error;
      try {
        result = await hub.invoke(message.target, message.arguments);
      } catch (e) {
        error = String(e.message ?? e);
      }
      if (message.invocationId !== undefined) {
        send(ws, error ? { type: 3, invocationId: message.invocationId, error } : { type: 3, invocationId: message.invocationId, result });
      }
    }
  });
}

async function invoke(target, args) {
  switch (target) {
    case 'GetConversation': {
      const id = state.latestByProject.get(args[0]) ?? null;
      return { conversationId: id, events: id ? state.conversations.get(id).events : [] };
    }
    case 'StartConversation': {
      const id = crypto.randomUUID();
      state.conversations.set(id, { projectPath: args[0], events: [], running: null });
      state.latestByProject.set(args[0], id);
      broadcast({ type: 'conversation', conversationId: id, projectPath: args[0], startedAt: new Date().toISOString() });
      return id;
    }
    case 'SendPrompt': {
      const request = args[0];
      const conversation = state.conversations.get(request.conversationId);
      if (!conversation) throw new Error('Nieznana rozmowa');
      if (conversation.running) throw new Error('Rozmowa jest zajęta');
      state.prompts.push(request);
      void runScript(request.conversationId, conversation, request.text);
      return null;
    }
    case 'AnswerPermission': {
      const { conversationId, requestId, decision } = args[0];
      const conversation = state.conversations.get(conversationId);
      if (conversation?.running?.permission?.requestId === requestId) {
        conversation.running.permission.resolve(decision);
      }
      return null;
    }
    case 'Interrupt': {
      const conversation = state.conversations.get(args[0].conversationId);
      conversation?.running?.cancel();
      return null;
    }
    default:
      throw new Error(`Nieznana metoda ${target}`);
  }
}

// ---------- terminal: simulated shell ----------

const promptFor = (terminal) => `\x1b[32mowner@dom\x1b[0m:\x1b[34m~/projekty${terminal.cwd ? '/' + terminal.cwd : ''}\x1b[0m$ `;

function terminalEmit(terminal, data) {
  terminal.seq++;
  terminal.history = (terminal.history + data).slice(-100_000);
  for (const ws of state.terminalSockets) {
    send(ws, { type: 1, target: 'TerminalOutput', arguments: [{ id: terminal.id, seq: terminal.seq, data }] });
  }
}

function runCommand(terminal, line) {
  const [command, ...rest] = line.trim().split(/\s+/);
  switch (command) {
    case undefined:
    case '':
      return '';
    case 'pwd':
      return `/srv/projects${terminal.cwd ? '/' + terminal.cwd : ''}\r\n`;
    case 'ls':
      return listDir(terminal.cwd).map((e) => e.name).sort().join('  ') + '\r\n';
    case 'echo':
      return rest.join(' ') + '\r\n';
    default:
      return `bash: ${command}: command not found\r\n`;
  }
}

function terminalInput(terminal, data) {
  terminal.inputs.push(data);
  if (terminal.exited || data.startsWith('\x1b')) return; // we skip key sequences (arrows etc.)
  for (const ch of data) {
    if (ch === '\r') {
      const line = terminal.line;
      terminal.line = '';
      if (line.trim() === 'exit') {
        terminalEmit(terminal, '\r\nlogout\r\n');
        terminal.exited = true;
        for (const ws of state.terminalSockets) {
          send(ws, { type: 1, target: 'TerminalExited', arguments: [{ id: terminal.id, exitCode: 0 }] });
        }
        return;
      }
      terminalEmit(terminal, '\r\n' + runCommand(terminal, line) + promptFor(terminal));
    } else if (ch === '\x7f') {
      if (terminal.line) {
        terminal.line = terminal.line.slice(0, -1);
        terminalEmit(terminal, '\b \b');
      }
    } else if (ch === '\x03') {
      terminal.line = '';
      terminalEmit(terminal, '^C\r\n' + promptFor(terminal));
    } else if (ch >= ' ') {
      terminal.line += ch;
      terminalEmit(terminal, ch);
    }
  }
}

const terminalInfo = ({ id, title, cwd, exited }) => ({ id, title, cwd, exited });

async function invokeTerminal(target, args) {
  const request = args[0] ?? {};
  const terminal = state.terminals.get(request.id);
  switch (target) {
    case 'ListTerminals':
      return [...state.terminals.values()].map(terminalInfo);
    case 'OpenTerminal': {
      const cwd = request.projectPath ?? '';
      const base = cwd ? cwd.slice(cwd.lastIndexOf('/') + 1) : 'projekty';
      const same = [...state.terminals.values()].filter((t) => t.title === base || t.title.startsWith(base + ' (')).length;
      const created = {
        id: `t${++state.terminalCounter}`,
        title: same ? `${base} (${same + 1})` : base,
        cwd,
        exited: false,
        seq: 0,
        history: '',
        line: '',
        inputs: [],
        sizes: [[request.cols, request.rows]]
      };
      state.terminals.set(created.id, created);
      state.log.push({ path: 'terminal-open', cwd });
      terminalEmit(created, promptFor(created));
      return terminalInfo(created);
    }
    case 'Attach':
      if (!terminal) throw new Error('Nieznany terminal');
      terminal.sizes.push([request.cols, request.rows]);
      return { snapshot: terminal.history, seq: terminal.seq };
    case 'Input':
      if (terminal) terminalInput(terminal, String(request.data ?? ''));
      return null;
    case 'Resize':
      terminal?.sizes.push([request.cols, request.rows]);
      return null;
    case 'CloseTerminal':
      if (!terminal) throw new Error('Nieznany terminal');
      state.terminals.delete(request.id);
      state.log.push({ path: 'terminal-close', id: request.id });
      return null;
    default:
      throw new Error(`Nieznana metoda ${target}`);
  }
}

/** "Claude reply" script that depends on the prompt text. */
async function runScript(conversationId, conversation, text) {
  let cancelled = false;
  const running = {
    cancel: () => {
      cancelled = true;
      running.permission?.resolve('deny');
    },
    permission: null
  };
  conversation.running = running;
  const emit = (event) => broadcast({ conversationId, ...event });
  const step = async (ms = 40) => {
    await sleep(ms);
    if (cancelled) throw new Error('cancelled');
  };
  const root = conversation.projectPath === '' ? '' : conversation.projectPath + '/';
  // Steps show paths relative to the conversation's project, `files-changed` always relative to the projects directory.
  const display = (p) => (root && p.startsWith(root) ? p.slice(root.length) : p);

  try {
    emit({ type: 'prompt', text });
    emit({ type: 'status', state: 'working' });

    if (text.includes('długo')) {
      for (;;) await step(100);
    }

    await step();
    emit({ type: 'step', stepId: 's1', kind: 'read', target: display(MAIN) });
    await step();
    state.files.set(MAIN, state.files.get(MAIN) + '// claude\n');
    emit({ type: 'step', stepId: 's2', kind: 'edit', target: display(MAIN), added: 1 });
    await step();
    state.files.set('studia/lab-3-sieci/NOTES.md', '# Notatki z konsoli\n');
    emit({ type: 'step', stepId: 's3', kind: 'write', target: display('studia/lab-3-sieci/NOTES.md'), added: 1 });
    emit({ type: 'files-changed', paths: [MAIN, 'studia/lab-3-sieci/NOTES.md'] });
    await step();
    emit({ type: 'step', stepId: 's4', kind: 'command', target: 'make test' });
    await step();
    emit({ type: 'step-output', stepId: 's4', text: '6 passed, 0 failed', isError: false });
    for (const delta of ['Gotowe. ', 'Dodałem komentarz ', 'do main.c.']) {
      await step(20);
      emit({ type: 'text', messageId: 'm1', delta });
    }

    if (text.includes('push')) {
      await step();
      const requestId = crypto.randomUUID();
      const decision = new Promise((resolve) => (running.permission = { requestId, resolve }));
      emit({ type: 'permission', requestId, description: 'git push origin main' });
      emit({ type: 'status', state: 'waiting' });
      const answer = await decision;
      running.permission = null;
      emit({ type: 'permission-resolved', requestId, decision: answer });
      await step();
      emit({ type: 'status', state: 'working' });
      if (answer === 'deny') {
        emit({ type: 'text', messageId: 'm2', delta: 'Nie wypycham zmian.' });
      } else {
        emit({ type: 'step', stepId: 's5', kind: 'command', target: 'git push origin main' });
        emit({ type: 'step-output', stepId: 's5', text: 'main -> main', isError: false });
        emit({ type: 'text', messageId: 'm2', delta: 'Wypchnięto.' });
      }
    }
    emit({ type: 'status', state: 'idle' });
  } catch {
    emit({ type: 'status', state: 'idle', message: 'przerwano' });
  } finally {
    conversation.running = null;
  }
}

server.listen(PORT, () => console.log(`mock api on ${ORIGIN}`));
