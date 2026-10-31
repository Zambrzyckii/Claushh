// Authentication routes of the e2e mock, with the current session, login and logout, extending the session, the
// session list with ending sessions and the login history. server.mjs lists the route order.

import crypto from 'node:crypto';

import { cookies, createSession, deviceOf, endSession, ipOf, json, readBody, xsrfOk } from '../http.mjs';
import { USER, state } from '../state.mjs';

const sessionTimes = (session) => ({
  expiresIn: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
  absoluteExpiresIn: Math.max(0, Math.round((session.absoluteExpiresAt - Date.now()) / 1000))
});

export async function authRoutes(req, res, url, session) {
  // authentication
  if (url.pathname === '/api/auth/me') {
    const token = crypto.randomUUID();
    state.xsrfTokens.set(token, session?.id ?? null);
    res.setHeader('Set-Cookie', `XSRF-TOKEN=${token}; Path=/; SameSite=Strict`);
    session ? json(res, 200, { userName: session.userName, sessionId: session.id, ...sessionTimes(session) }) : json(res, 401);
    return true;
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const ok = xsrfOk(req);
    const body = await readBody(req);
    state.log.push({ path: url.pathname, xsrf: ok });
    if (!ok) {
      json(res, 400);
      return true;
    }
    if (state.loginFailures >= 3) {
      json(res, 429, undefined, { 'Retry-After': '30' });
      return true;
    }
    const attempt = { at: new Date().toISOString(), ip: ipOf(req), device: deviceOf(req), method: 'password' };
    if (body?.userName !== USER.userName || body?.password !== USER.password || body?.totpCode !== USER.totpCode) {
      state.loginFailures++;
      state.logins.unshift({ ...attempt, success: false });
      json(res, 401);
      return true;
    }
    state.logins.unshift({ ...attempt, success: true });
    const sid = createSession(req);
    json(res, 204, undefined, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Strict` });
    return true;
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const ok = xsrfOk(req);
    const body = await readBody(req);
    state.log.push({ path: url.pathname, xsrf: ok, hadSession: !!session, sessionId: body?.sessionId });
    if (!ok) {
      json(res, 400);
      return true;
    }
    if (!session) {
      json(res, 401);
      return true;
    }
    // Logout of a specific session: the cookie already belongs to another one (a new login), so we end nothing.
    if (body?.sessionId && body.sessionId !== session.id) {
      json(res, 409);
      return true;
    }
    endSession(cookies(req).sid);
    json(res, 204, undefined, {
      // Deliberately without Clear-Site-Data: Chrome can then hold the response for several seconds
      // (especially with a second open tab). The frontend clears storage, the API has no-store.
      'Set-Cookie': ['sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict', 'XSRF-TOKEN=; Path=/; Max-Age=0; SameSite=Strict']
    });
    return true;
  }

  // extending the session, session list, login history
  if (url.pathname === '/api/auth/keepalive' && req.method === 'POST') {
    if (!session) {
      json(res, 401);
      return true;
    }
    if (!xsrfOk(req)) {
      json(res, 400);
      return true;
    }
    session.expiresAt = Date.now() + state.idleSeconds * 1000;
    session.lastActivityAt = new Date().toISOString();
    state.log.push({ path: 'keepalive' });
    json(res, 200, { sessionId: session.id, ...sessionTimes(session) });
    return true;
  }
  if (url.pathname.startsWith('/api/auth/sessions') || url.pathname === '/api/auth/logins') {
    if (!session) {
      json(res, 401);
      return true;
    }
    if (req.method !== 'GET' && !xsrfOk(req)) {
      json(res, 400);
      return true;
    }
    const currentSid = cookies(req).sid;
    if (url.pathname === '/api/auth/logins' && req.method === 'GET') {
      json(res, 200, state.logins.slice(0, 20));
      return true;
    }
    if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
      json(res, 200, [...state.sessions].reverse().map(([sid, s]) => ({
        id: s.id, current: sid === currentSid, device: s.device, ip: s.ip, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt
      })));
      return true;
    }
    if (url.pathname === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
      for (const sid of [...state.sessions.keys()]) if (sid !== currentSid) endSession(sid);
      state.log.push({ path: 'revoke-others' });
      json(res, 204);
      return true;
    }
    const match = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (match && req.method === 'DELETE') {
      const entry = [...state.sessions].find(([, s]) => s.id === decodeURIComponent(match[1]));
      if (!entry) {
        json(res, 404);
        return true;
      }
      if (entry[0] === currentSid) {
        json(res, 400, { message: 'Your own session ends with a logout.' });
        return true;
      }
      endSession(entry[0]);
      state.log.push({ path: 'revoke', id: entry[1].id });
      json(res, 204);
      return true;
    }
    json(res, 404);
    return true;
  }

  return false;
}
