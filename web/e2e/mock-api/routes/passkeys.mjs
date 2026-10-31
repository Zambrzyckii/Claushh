// Passkey routes of the e2e mock, with the backend's passkey limits and texts, re-authentication, the passkey login
// and the list, registration, renaming and removal of the account's passkeys. server.mjs lists the route order.

import crypto from 'node:crypto';

import { ORIGINS, cookies, createSession, deviceOf, ipOf, json, readBody, xsrfOk } from '../http.mjs';
import { USER, state } from '../state.mjs';

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

export async function passkeyRoutes(req, res, url, session) {
  // re-authentication and the account's passkeys
  if (url.pathname === '/api/auth/reauthenticate' && req.method === 'POST') {
    if (!session) {
      json(res, 401);
      return true;
    }
    if (!xsrfOk(req)) {
      json(res, 400);
      return true;
    }
    const body = await readBody(req).catch(() => null);
    if (state.loginFailures >= 3) {
      json(res, 429, undefined, { 'Retry-After': '30' });
      return true;
    }
    if (body?.password !== USER.password || body?.totpCode !== USER.totpCode) {
      state.loginFailures++;
      state.logins.unshift({ at: new Date().toISOString(), ip: ipOf(req), device: deviceOf(req), success: false, method: 'password' });
      json(res, 403);
      return true;
    }
    state.freshUntil.set(cookies(req).sid, Date.now() + PASSKEY_FRESH_MS);
    json(res, 204);
    return true;
  }
  // the passkey login, anonymous like /api/auth/login
  if ((url.pathname === '/api/auth/passkeys/login-options' || url.pathname === '/api/auth/passkeys/login') && req.method === 'POST') {
    const ok = xsrfOk(req);
    const body = await readBody(req).catch(() => null);
    state.log.push({ path: url.pathname, xsrf: ok });
    if (!ok) {
      json(res, 400);
      return true;
    }
    if (state.loginFailures >= 3) {
      json(res, 429, undefined, { 'Retry-After': '30' });
      return true;
    }
    if (url.pathname === '/api/auth/passkeys/login-options') {
      const id = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.randomBytes(32));
      state.challenges.set(id, challenge);
      json(res, 200, { challenge, timeout: 300000, rpId: 'localhost', allowCredentials: [], userVerification: 'required' },
        { 'Set-Cookie': `passkey=${id}; Path=/; Max-Age=300; HttpOnly; SameSite=Strict` });
      return true;
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
      json(res, 401, undefined, { 'Set-Cookie': expire });
      return true;
    }
    state.logins.unshift({ ...attempt, success: true });
    const sid = createSession(req);
    json(res, 204, undefined, { 'Set-Cookie': [`sid=${sid}; Path=/; HttpOnly; SameSite=Strict`, expire] });
    return true;
  }
  if (url.pathname === '/api/auth/passkeys' || url.pathname.startsWith('/api/auth/passkeys/')) {
    if (!session) {
      json(res, 401);
      return true;
    }
    if (req.method !== 'GET' && !xsrfOk(req)) {
      json(res, 400);
      return true;
    }
    const sid = cookies(req).sid;
    const fresh = (state.freshUntil.get(sid) ?? 0) > Date.now();
    if (url.pathname === '/api/auth/passkeys' && req.method === 'GET') {
      json(res, 200, state.passkeys);
      return true;
    }
    if (url.pathname === '/api/auth/passkeys/creation-options' && req.method === 'POST') {
      if (!fresh) {
        json(res, 403);
        return true;
      }
      if (state.passkeys.length >= PASSKEY_LIMIT) {
        json(res, 409, { message: PASSKEY_LIMIT_TEXT });
        return true;
      }
      const challenge = base64url(crypto.randomBytes(32));
      state.registrations.set(sid, challenge);
      json(res, 200, {
        rp: { name: 'localhost', id: 'localhost' },
        user: { id: base64url(USER_ID), name: USER.userName, displayName: USER.userName },
        challenge,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: 300000,
        excludeCredentials: state.passkeys.map((p) => ({ type: 'public-key', id: p.id, transports: [] })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
      return true;
    }
    if (url.pathname === '/api/auth/passkeys' && req.method === 'POST') {
      const body = await readBody(req).catch(() => null);
      const credential = body?.credential;
      if (typeof credential !== 'object' || credential === null) {
        json(res, 400, { message: PASSKEY_NOT_ADDED });
        return true;
      }
      const given = body.name;
      const blank = given === undefined || given === null || (typeof given === 'string' && given.trim() === '');
      const name = blank ? deviceOf(req) : passkeyName(given);
      if (!name) {
        json(res, 400, { message: PASSKEY_NAME_RULE });
        return true;
      }
      const challenge = state.registrations.get(sid);
      state.registrations.delete(sid);
      if (!challenge) {
        json(res, 400, { message: PASSKEY_NOT_ADDED });
        return true;
      }
      if (state.passkeys.length >= PASSKEY_LIMIT) {
        json(res, 409, { message: PASSKEY_LIMIT_TEXT });
        return true;
      }
      const clientData = clientDataOf(credential);
      const authenticatorData = Buffer.from(credential.response?.authenticatorData ?? '', 'base64url');
      if (clientData?.type !== 'webauthn.create' || clientData.challenge !== challenge || !ORIGINS.includes(clientData.origin)
        || typeof credential.id !== 'string' || !credential.id || state.passkeys.some((p) => p.id === credential.id)
        || authenticatorData.length < 37) {
        json(res, 400, { message: PASSKEY_NOT_ADDED });
        return true;
      }
      const passkey = { id: credential.id, name, createdAt: new Date().toISOString(), synced: (authenticatorData[32] & 0x08) !== 0 };
      state.passkeys.push(passkey);
      json(res, 201, passkey);
      return true;
    }
    const match = url.pathname.match(/^\/api\/auth\/passkeys\/([^/]+)$/);
    const passkey = match ? state.passkeys.find((p) => p.id === decodeURIComponent(match[1])) : undefined;
    if (match && req.method === 'PATCH') {
      const name = passkeyName((await readBody(req).catch(() => null))?.name);
      if (!name) {
        json(res, 400, { message: PASSKEY_NAME_RULE });
        return true;
      }
      if (!passkey) {
        json(res, 404);
        return true;
      }
      passkey.name = name;
      json(res, 204);
      return true;
    }
    if (match && req.method === 'DELETE') {
      if (!fresh) {
        json(res, 403);
        return true;
      }
      if (!passkey) {
        json(res, 404);
        return true;
      }
      state.passkeys = state.passkeys.filter((p) => p !== passkey);
      json(res, 204);
      return true;
    }
    json(res, 404);
    return true;
  }

  return false;
}
