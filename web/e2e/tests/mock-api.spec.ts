import os from 'node:os';

import { expect, test } from './fixtures';
import { resetMock } from './helpers';

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

test('a token issued before logging in is refused afterwards (XSRF bound to the identity)', async ({ request }) => {
  await request.get('/api/auth/me');
  const xsrf = (await request.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')!.value;
  await request.post('/api/auth/login', { headers: { 'X-XSRF-TOKEN': xsrf }, data: { userName: 'owner', password: 'secret', totpCode: '123456' } });
  const response = await request.post('/api/auth/keepalive', { headers: { 'X-XSRF-TOKEN': xsrf } });
  expect(response.status()).toBe(400);
});
