import os from 'node:os';
import crypto from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './fixtures';
import { USER, login, mockState, resetMock, setRepoState } from './helpers';

/** Mock backend: tests of the mock itself (it has unprotected /__test/*) and of contract rules that the frontend does not let through. */

test.beforeEach(async ({ request }) => resetMock(request));

test('the test server survives malformed requests', async ({ request }) => {
  expect((await request.get('/%E0%A4%A')).status()).toBe(400);
  expect((await request.put('/__test/file', { headers: { 'Content-Type': 'application/json' }, data: Buffer.from('{nie json') })).status()).toBe(400);
  expect((await request.get('/__test/state')).ok()).toBe(true);
});

test('the test server listens only on the loopback interface', async ({ request }) => {
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((address) => address && address.family === 'IPv4' && !address.internal);
  test.skip(!external, 'brak interfejsu sieciowego innego niż loopback');
  await expect(request.get(`http://${external!.address}:4400/__test/state`, { timeout: 3000 })).rejects.toThrow();
});

test('the mock refuses clone addresses that the contract forbids, also when the frontend is bypassed', async ({ request }) => {
  const login = await request.get('/api/auth/me');
  expect(login.status()).toBe(401); // issues an XSRF token
  const xsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  await request.post('/api/auth/login', {
    headers: { 'X-XSRF-TOKEN': xsrf },
    data: { userName: 'owner', password: 'secret', totpCode: '123456' }
  });
  // The XSRF token is bound to the identity: after login a new one is needed.
  expect((await request.get('/api/auth/me')).status()).toBe(200);
  const sessionXsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  for (const url of ['https://github.com\\@evil.example/o/r.git', 'https://github.com/o/../r', 'https://github.com/o/...git', 'http://github.com/o/r']) {
    const response = await request.post('/api/repos/clone', { headers: { 'X-XSRF-TOKEN': sessionXsrf }, data: { workspace: 'studia', url } });
    expect(response.status(), url).toBe(400);
  }
});

test('the mock saves like the files API: `absent` creates a file, not a directory, over 5 MB is 413, a NUL character is 415', async ({ request }) => {
  await request.get('/api/auth/me');
  const anonymous = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  await request.post('/api/auth/login', { headers: { 'X-XSRF-TOKEN': anonymous }, data: USER });
  await request.get('/api/auth/me'); // a token issued for the session
  const xsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  const url = (path: string) => `/api/files/content?path=${encodeURIComponent(path)}`;
  const save = (path: string, data: object) => request.put(url(path), { headers: { 'X-XSRF-TOKEN': xsrf }, data });
  const existing = 'prywatne/notatki/README.md';
  const created = 'prywatne/notatki/nowy.md';
  const { version } = await (await request.get(url(existing))).json();

  // A file that does not exist has the version `absent`, and a save with it creates the file.
  const stale = await save(created, { content: 'x', baseVersion: version });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toEqual({ currentVersion: 'absent' });
  expect((await save(created, { content: 'nowy\n', baseVersion: 'absent' })).status()).toBe(200);
  expect((await mockState(request)).files[created]).toBe('nowy\n');
  const taken = await save(created, { content: 'drugi\n', baseVersion: 'absent' });
  expect(taken.status()).toBe(409);
  expect((await taken.json()).currentVersion).not.toBe('absent');

  // As in the backend: a save creates a file only in a directory that exists, and a file is no directory.
  expect((await save('prywatne/brak/nowy.md', { content: 'x', baseVersion: 'absent' })).status()).toBe(404);
  expect((await save(`${existing}/nowy.md`, { content: 'x', baseVersion: 'absent' })).status()).toBe(404);

  // More than 5 MB (counted in bytes, not characters) and a NUL character are refused, whatever the version.
  const limit = 5 * 1024 * 1024;
  expect((await save(existing, { content: 'a'.repeat(limit + 1), baseVersion: version })).status()).toBe(413);
  expect((await save(existing, { content: 'ż'.repeat(limit / 2 + 1), baseVersion: version })).status()).toBe(413);
  expect((await save(existing, { content: 'a\u0000b', baseVersion: version })).status()).toBe(415);
  expect((await save(existing, { content: 'a\u0000b', baseVersion: 'stale' })).status()).toBe(415);
  expect((await save(existing, { content: 'x' })).status()).toBe(400);
  expect((await mockState(request)).files[existing]).toBe('# Notatki\n');
  expect((await save(existing, { content: 'a'.repeat(limit), baseVersion: version })).status()).toBe(200);
});

test('the mock refuses workspace, repo and path parameters that are not valid paths, like the backend', async ({ request }) => {
  await request.get('/api/auth/me');
  const xsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  await request.post('/api/auth/login', { headers: { 'X-XSRF-TOKEN': xsrf }, data: { userName: 'owner', password: 'secret', totpCode: '123456' } });
  await request.get('/api/auth/me');
  const sessionXsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  const lab = encodeURIComponent('studia/lab-3-sieci');
  for (const url of [
    '/api/repos',
    `/api/repos?workspace=${encodeURIComponent('../studia')}`,
    `/api/git/status?repo=studia`,
    `/api/git/status?repo=${encodeURIComponent('studia/../x')}`,
    `/api/git/show?repo=${lab}&path=${encodeURIComponent('studia/so-projekt-shell/src/shell.c')}`,
    `/api/git/show?repo=${lab}&path=${encodeURIComponent('studia/lab-3-sieci/.git/config')}`
  ]) {
    expect((await request.get(url)).status(), url).toBe(400);
  }
  const clone = await request.post('/api/repos/clone', {
    headers: { 'X-XSRF-TOKEN': sessionXsrf },
    data: { workspace: 'studia/lab-3-sieci', url: 'https://github.com/o/r.git' }
  });
  expect(clone.status()).toBe(400);
  // A binary file in HEAD is 415 (the files API's rule), not "not in HEAD".
  expect((await request.get(`/api/git/show?repo=${lab}&path=${encodeURIComponent('studia/lab-3-sieci/logo.png')}`)).status()).toBe(415);
});

test('push and pull follow the contract\'s ahead/behind rule (docs/ARCHITECTURE.md, "Workspaces and git")', async ({ request }) => {
  await request.get('/api/auth/me');
  const xsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  await request.post('/api/auth/login', { headers: { 'X-XSRF-TOKEN': xsrf }, data: USER });
  await request.get('/api/auth/me');
  const sessionXsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  const repo = 'studia/bazy-danych-lab'; // ahead 0 / behind 2 by default.
  const push = (headers: Record<string, string>) =>
    request.post(`/api/git/push?repo=${encodeURIComponent(repo)}`, { headers });
  const pull = (headers: Record<string, string>) =>
    request.post(`/api/git/pull?repo=${encodeURIComponent(repo)}`, { headers });

  // Nothing ahead: nothing to push, even though behind is non-zero (the contract's rule the frontend never exercises
  // on its own, since it only pushes a repository the panel shows with ↑ > 0).
  const nothingToPush = await push({ 'X-XSRF-TOKEN': sessionXsrf });
  expect(nothingToPush.status()).toBe(200);
  expect(await nothingToPush.json()).toEqual({ message: 'Nic do wypchnięcia.' });

  // Ahead and behind both non-zero: diverged, so pull cannot fast-forward.
  await setRepoState(request, repo, { ahead: 1 });
  expect((await pull({ 'X-XSRF-TOKEN': sessionXsrf })).status()).toBe(409);
});

test('a token issued before logging in is refused afterwards (XSRF bound to the identity)', async ({ request }) => {
  await request.get('/api/auth/me');
  const xsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  await request.post('/api/auth/login', { headers: { 'X-XSRF-TOKEN': xsrf }, data: { userName: 'owner', password: 'secret', totpCode: '123456' } });
  const response = await request.post('/api/auth/keepalive', { headers: { 'X-XSRF-TOKEN': xsrf } });
  expect(response.status()).toBe(400);
});

test('the mock refuses console paths, prompts and options that the contract forbids, like the backend', async ({ page, request }) => {
  await login(page);
  const errors = await page.evaluate(async () => {
    const RS = '\x1e';
    const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/hubs/console');
    const pending = new Map<string, (reply: { result?: unknown; error?: string }) => void>();
    let handshake!: () => void;
    const ready = new Promise<void>((resolve) => (handshake = resolve));
    socket.onmessage = (event) => {
      for (const part of String(event.data).split(RS).filter(Boolean)) {
        const message = JSON.parse(part);
        if (message.type === undefined) handshake();
        else if (message.type === 3) pending.get(message.invocationId)?.(message);
      }
    };
    await new Promise((resolve) => (socket.onopen = resolve));
    socket.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
    await ready;
    let next = 0;
    const invoke = (target: string, ...args: unknown[]) =>
      new Promise<{ result?: unknown; error?: string }>((resolve) => {
        const invocationId = String(++next);
        pending.set(invocationId, resolve);
        socket.send(JSON.stringify({ type: 1, invocationId, target, arguments: args }) + RS);
      });
    const conversationId = (await invoke('StartConversation', 'studia/lab-3-sieci')).result;
    const options = { model: 'haiku', effort: 'low', mode: 'default' };
    const replies = [
      await invoke('GetConversation', '../etc'),
      await invoke('StartConversation', '/etc'),
      await invoke('SendPrompt', { conversationId, text: 'x'.repeat(100_001), ...options }),
      await invoke('SendPrompt', { conversationId, text: '', ...options }),
      await invoke('SendPrompt', { conversationId, text: 'x', ...options, effort: 'xhigh' })
    ];
    socket.close();
    return replies.map((reply) => reply.error);
  });
  expect(errors).toEqual([
    'Nieprawidłowa ścieżka',
    'Nieprawidłowa ścieżka',
    'Nieprawidłowe polecenie',
    'Nieprawidłowe polecenie',
    'Nieprawidłowe opcje'
  ]);
  expect((await mockState(request)).prompts).toHaveLength(0);
});

test('the mock follows the passkey management contract like the backend', async ({ request }) => {
  const xsrf = await apiLogin(request);
  const post = (path: string, data?: object) => request.post(path, { headers: { 'X-XSRF-TOKEN': xsrf }, data });
  const reauthenticate = (password: string) => post('/api/auth/reauthenticate', { password, totpCode: USER.totpCode });
  const create = (options: { challenge: string }, origin?: string, flags?: number) =>
    fakeCredential('k1', options, 'webauthn.create', { origin, flags });

  // Adding needs a fresh re-authentication; a wrong one is 403.
  expect((await post('/api/auth/passkeys/creation-options')).status()).toBe(403);
  expect((await reauthenticate('wrong')).status()).toBe(403);
  expect((await reauthenticate(USER.password)).status()).toBe(204);
  const options = await (await post('/api/auth/passkeys/creation-options')).json();
  expect(options.rp.id).toBe('localhost');
  expect(options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });

  // The name is checked first and keeps the state; a foreign origin uses it up.
  const badName = await post('/api/auth/passkeys', { credential: create(options), name: 'a\u0007b' });
  expect(badName.status()).toBe(400);
  expect(await badName.json()).toEqual({ message: 'A passkey name has 1 to 64 characters and no control characters.' });
  const foreign = await post('/api/auth/passkeys', { credential: create(options, 'https://evil.test') });
  expect(foreign.status()).toBe(400);
  expect(await foreign.json()).toEqual({ message: 'The passkey could not be added. Try again.' });
  expect((await post('/api/auth/passkeys', { credential: create(options) })).status()).toBe(400);

  const fresh = await (await post('/api/auth/passkeys/creation-options')).json();
  const added = await post('/api/auth/passkeys', { credential: create(fresh, undefined, 0x0d), name: ' Laptop ' });
  expect(added.status()).toBe(201);
  expect(await added.json()).toMatchObject({ id: 'k1', name: 'Laptop', synced: true });

  // Rename checks the name, then the id; removing needs the fresh session.
  const patch = (id: string, name: string) => request.patch(`/api/auth/passkeys/${id}`, { headers: { 'X-XSRF-TOKEN': xsrf }, data: { name } });
  expect((await patch('k1', '')).status()).toBe(400);
  expect((await patch('nope', 'Phone')).status()).toBe(404);
  expect((await patch('k1', 'Phone')).status()).toBe(204);
  expect(await (await request.get('/api/auth/passkeys')).json()).toEqual([expect.objectContaining({ id: 'k1', name: 'Phone', synced: true })]);
  expect((await request.delete('/api/auth/passkeys/k1', { headers: { 'X-XSRF-TOKEN': xsrf } })).status()).toBe(204);
  expect((await mockState(request)).passkeyCount).toBe(0);

  // Like login: the third failure turns re-authentication into 429.
  await reauthenticate('wrong');
  await reauthenticate('wrong');
  const limited = await reauthenticate(USER.password);
  expect(limited.status()).toBe(429);
  expect(limited.headers()['retry-after']).toBe('30');
});

/** Logs in through the API alone and returns the XSRF token issued for the new session. */
async function apiLogin(request: APIRequestContext): Promise<string> {
  await request.get('/api/auth/me');
  await request.post('/api/auth/login', { headers: { 'X-XSRF-TOKEN': await xsrfToken(request) }, data: USER });
  await request.get('/api/auth/me');
  return xsrfToken(request);
}

async function xsrfToken(request: APIRequestContext): Promise<string> {
  return (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
}

/**
 * A credential as the browser's JSON has it, enough for the mock, which checks client data, flags and the user handle
 * but never signatures. `flags` is the authenticator data's flags byte (0x05: user present and verified).
 */
function fakeCredential(
  id: string,
  options: { challenge: string },
  type: 'webauthn.create' | 'webauthn.get',
  { origin = 'http://localhost:4400', flags = 0x05, userHandle }: { origin?: string; flags?: number; userHandle?: string } = {}
) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false })).toString('base64url');
  const rpIdHash = crypto.createHash('sha256').update('localhost').digest();
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags, 0, 0, 0, 1])]).toString('base64url');
  return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, authenticatorData, userHandle } };
}
