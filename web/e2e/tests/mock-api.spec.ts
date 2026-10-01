import os from 'node:os';

import { expect, test } from './fixtures';
import { USER, mockState, resetMock } from './helpers';

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

test('the mock saves like the files API: `absent` creates a file, over 5 MB is 413, a NUL character is 415', async ({ request }) => {
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

test('a token issued before logging in is refused afterwards (XSRF bound to the identity)', async ({ request }) => {
  await request.get('/api/auth/me');
  const xsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  await request.post('/api/auth/login', { headers: { 'X-XSRF-TOKEN': xsrf }, data: { userName: 'owner', password: 'secret', totpCode: '123456' } });
  const response = await request.post('/api/auth/keepalive', { headers: { 'X-XSRF-TOKEN': xsrf } });
  expect(response.status()).toBe(400);
});
