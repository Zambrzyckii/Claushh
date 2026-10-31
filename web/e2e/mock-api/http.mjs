// Request helpers of the e2e mock, with its address and accepted origins, cookies and sessions, the XSRF check,
// reading and answering JSON, the API path check and the security headers. The route order is listed in server.mjs.

import crypto from 'node:crypto';

import { USER, state } from './state.mjs';

export const PORT = Number(process.env.MOCK_PORT ?? 4400);
export const HOST = '127.0.0.1';
export const ORIGIN = `http://${HOST}:${PORT}`;
/** The origins the portal is served from in the e2e tests (hubs and passkeys): passkeys need a domain, not an IP. */
export const ORIGINS = [ORIGIN, `http://localhost:${PORT}`];

export const cookies = (req) =>
  Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
const expired = (session) => Date.now() > session.expiresAt || Date.now() > session.absoluteExpiresAt;

/** Valid session with the given secret. An expired one (inactivity or hard limit) is removed, as on the real server. */
export function validSession(sid) {
  const session = state.sessions.get(sid);
  if (session && expired(session)) {
    endSession(sid);
    return undefined;
  }
  return session;
}

/** Session from the cookie. */
export const sessionOf = (req) => validSession(cookies(req).sid);

export function endSession(sid) {
  state.sessions.delete(sid);
  for (const ws of [...state.sockets, ...state.terminalSockets]) {
    if (ws.sid === sid) ws.terminate();
  }
}

export function deviceOf(req) {
  const ua = req.headers['user-agent'] ?? '';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrom/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system';
  return `${browser} · ${os}`;
}

export const ipOf = (req) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
/**
 * XSRF token: header equal to the cookie and issued for the same identity as the current request (a session or none),
 * as in ASP.NET antiforgery. So a token from before logout will not pass at login.
 */
export function xsrfOk(req) {
  const token = cookies(req)['XSRF-TOKEN'];
  return !!token && req.headers['x-xsrf-token'] === token && state.xsrfTokens.has(token) && state.xsrfTokens.get(token) === (sessionOf(req)?.id ?? null);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Request body as JSON. Invalid JSON rejects the promise (the handler responds 400, the server keeps running). */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(body === undefined ? '' : JSON.stringify(body));
}

/**
 * `workspace`, `repo` and `path` parameters use the files API's path syntax (docs/ARCHITECTURE.md, "Workspaces and
 * git"): non-empty segments joined by "/", none of them ".", "..", ".git", no "\" and no NUL; `segments` fixes their
 * number. Anything else is 400, as in the backend.
 */
export function isApiPath(p, segments) {
  if (typeof p !== 'string') return false;
  const parts = p.split('/');
  return (segments === undefined || parts.length === segments)
    && parts.every((s) => s !== '' && s !== '.' && s !== '..' && s !== '.git' && !s.includes('\\') && !s.includes('\0'));
}

/** A new session of the owner, as after a login; returns its secret for the cookie. */
export function createSession(req) {
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
  return sid;
}

// Security headers required from the backend (docs/ARCHITECTURE.md, "Security headers").
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
};
