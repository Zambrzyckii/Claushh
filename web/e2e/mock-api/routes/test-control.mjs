// Test control routes of the e2e mock (`/__test/*`), with which the tests reset the state, shorten the session
// timeout, end the sessions, read the state, set a file, the terminal theme or a repository's ahead and behind,
// drop the sockets and inject faults. server.mjs lists the route order.

import { json, readBody } from '../http.mjs';
import { reset, snapshotCommitted, state } from '../state.mjs';

export async function testControlRoutes(req, res, url, session) {
  // test control
  if (url.pathname === '/__test/reset') {
    reset();
    snapshotCommitted();
    json(res, 204);
    return true;
  }
  if (url.pathname === '/__test/session-timeout') {
    // Shortens the inactivity timeout (also for existing sessions), so the countdown test does not wait 30 minutes.
    state.idleSeconds = Number(url.searchParams.get('idle') ?? 1800);
    for (const session of state.sessions.values()) session.expiresAt = Date.now() + state.idleSeconds * 1000;
    json(res, 204);
    return true;
  }
  if (url.pathname === '/__test/kill-sessions') {
    state.sessions.clear();
    // keepSockets=1: the session is invalidated, but open WebSockets stay (a test of the HTTP interceptor alone).
    if (url.searchParams.get('keepSockets') !== '1') {
      for (const socket of [...state.sockets, ...state.terminalSockets]) socket.terminate();
    }
    json(res, 204);
    return true;
  }
  if (url.pathname === '/__test/state') {
    const terminals = [...state.terminals.values()].map(({ id, title, cwd, exited, inputs, sizes }) => ({ id, title, cwd, exited, inputs, sizes }));
    json(res, 200, { files: Object.fromEntries(state.files), log: state.log, prompts: state.prompts, terminals, passkeyCount: state.passkeys.length, registrationCount: state.registrations.size, freshCount: state.freshUntil.size, challengeCount: state.challenges.size });
    return true;
  }
  if (url.pathname === '/__test/file' && req.method === 'PUT') {
    const body = await readBody(req);
    state.files.set(body.path, body.content);
    json(res, 204);
    return true;
  }
  if (url.pathname === '/__test/terminal-theme' && req.method === 'PUT') {
    // A pywal colors.json as text for GET /api/terminal/theme (null: none, as after a reset).
    const body = await readBody(req);
    state.terminalThemeFile = typeof body?.content === 'string' ? body.content : null;
    json(res, 204);
    return true;
  }
  if (url.pathname === '/__test/repo-state' && req.method === 'POST') {
    // A test's own ahead/behind for a repository, so it does not have to add a fourth repository (which would move
    // the list other tests pin) to get a push rejection or a diverged pull.
    const body = await readBody(req);
    const repo = body && state.repos.get(body.repo);
    if (!repo) {
      json(res, 400);
      return true;
    }
    if (typeof body.ahead === 'number') repo.ahead = body.ahead;
    if (typeof body.behind === 'number') repo.behind = body.behind;
    json(res, 204);
    return true;
  }
  if (url.pathname === '/__test/drop-sockets') {
    // Dropped connections without ending the session (e.g. a brief network failure): the client reconnects.
    for (const socket of [...state.sockets, ...state.terminalSockets]) socket.terminate();
    json(res, 204);
    return true;
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
    return true;
  }

  return false;
}
