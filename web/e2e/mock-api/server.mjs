// Mock backend for e2e tests: serves the built frontend (dist/web/browser) and implements the contracts
// from docs/ARCHITECTURE.md (authentication, files, the console hub in the SignalR JSON protocol over WebSocket).
// Instead of the real Claude Code it replays short scripts that depend on the prompt text.
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
  'prywatne/notatki/README.md': '# Notatki\n'
};

let state;
function reset() {
  for (const socket of state?.sockets ?? []) socket.terminate();
  state = {
    sessions: new Map(),
    loginFailures: 0,
    files: new Map(Object.entries(INITIAL_FILES)),
    log: [],
    sockets: new Set(),
    conversations: new Map(), // id -> { projectPath, events, running }
    latestByProject: new Map(),
    prompts: []
  };
}
reset();

// ---------- helpers ----------

const cookies = (req) =>
  Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
const sessionOf = (req) => state.sessions.get(cookies(req).sid);
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
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(body === undefined ? '' : JSON.stringify(body));
}

function listDir(dir) {
  const out = new Map();
  for (const p of state.files.keys()) {
    if (dir && !p.startsWith(dir + '/')) continue;
    const rest = dir ? p.slice(dir.length + 1) : p;
    const [name, ...more] = rest.split('/');
    out.set(name, { name, path: dir ? `${dir}/${name}` : name, kind: more.length ? 'directory' : 'file' });
  }
  return [...out.values()];
}

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const session = sessionOf(req);

  // test control
  if (url.pathname === '/__test/reset') { reset(); json(res, 204); return; }
  if (url.pathname === '/__test/kill-sessions') {
    state.sessions.clear();
    // keepSockets=1: the session is invalidated, but open WebSockets stay (a test of the HTTP interceptor alone).
    if (url.searchParams.get('keepSockets') !== '1') {
      for (const socket of state.sockets) socket.terminate();
    }
    json(res, 204);
    return;
  }
  if (url.pathname === '/__test/state') {
    json(res, 200, { files: Object.fromEntries(state.files), log: state.log, prompts: state.prompts });
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
    session ? json(res, 200, { userName: session.userName }) : json(res, 401);
    return;
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const ok = xsrfOk(req);
    const body = await readBody(req);
    state.log.push({ path: url.pathname, xsrf: ok });
    if (!ok) return json(res, 400);
    if (state.loginFailures >= 3) return json(res, 429, undefined, { 'Retry-After': '30' });
    if (body?.userName !== USER.userName || body?.password !== USER.password || body?.totpCode !== USER.totpCode) {
      state.loginFailures++;
      return json(res, 401);
    }
    const sid = crypto.randomUUID();
    state.sessions.set(sid, { userName: USER.userName });
    return json(res, 204, undefined, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Strict` });
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const ok = xsrfOk(req);
    state.log.push({ path: url.pathname, xsrf: ok, hadSession: !!session });
    if (!ok) return json(res, 400);
    if (!session) return json(res, 401);
    state.sessions.delete(cookies(req).sid);
    return json(res, 204, undefined, {
      'Set-Cookie': ['sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict', 'XSRF-TOKEN=; Path=/; Max-Age=0; SameSite=Strict'],
      'Clear-Site-Data': '"cache", "storage"'
    });
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

// ---------- console hub (SignalR JSON protocol) ----------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname !== '/hubs/console' || !sessionOf(req) || req.headers.origin !== ORIGIN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
});

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message) + RS);
}

function broadcast(event) {
  const conversation = state.conversations.get(event.conversationId);
  conversation?.events.push(event);
  for (const ws of state.sockets) send(ws, { type: 1, target: 'ConsoleEvent', arguments: [event] });
}

function onConnection(ws) {
  let handshake = false;
  const ping = setInterval(() => send(ws, { type: 6 }), 5000);
  ws.on('close', () => {
    clearInterval(ping);
    state.sockets.delete(ws);
  });
  ws.on('message', async (raw) => {
    for (const part of raw.toString().split(RS).filter(Boolean)) {
      const message = JSON.parse(part);
      if (!handshake) {
        handshake = true;
        state.sockets.add(ws);
        ws.send('{}' + RS);
        continue;
      }
      if (message.type !== 1) continue;
      let result = null;
      let error;
      try {
        result = await invoke(message.target, message.arguments);
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

  try {
    emit({ type: 'prompt', text });
    emit({ type: 'status', state: 'working' });

    if (text.includes('długo')) {
      for (;;) await step(100);
    }

    await step();
    emit({ type: 'step', stepId: 's1', kind: 'read', target: `${root}${MAIN}` });
    await step();
    state.files.set(MAIN, state.files.get(MAIN) + '// claude\n');
    emit({ type: 'step', stepId: 's2', kind: 'edit', target: MAIN, added: 1 });
    await step();
    state.files.set('studia/lab-3-sieci/NOTES.md', '# Notatki z konsoli\n');
    emit({ type: 'step', stepId: 's3', kind: 'write', target: 'studia/lab-3-sieci/NOTES.md', added: 1 });
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
