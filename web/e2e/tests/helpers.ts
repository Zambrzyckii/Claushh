import { APIRequestContext, CDPSession, Locator, Page, expect } from '@playwright/test';

/** Data and paths from the mock backend (e2e/mock-api/server.mjs). */
export const USER = { userName: 'owner', password: 'secret', totpCode: '123456' };
export const MAIN = 'studia/lab-3-sieci/src/main.c';
export const LAB = 'studia/lab-3-sieci';
export const BAZY_SQL = 'studia/bazy-danych-lab/zadanie4.sql';

/** The mock and its /__test/* endpoints: always at 127.0.0.1, also in tests that open the portal at localhost. */
export const MOCK_ORIGIN = 'http://127.0.0.1:4400';
/** Where the passkey tests open the portal: WebAuthn refuses an IP address (docs/ARCHITECTURE.md, "Tests"). */
export const PASSKEY_ORIGIN = 'http://localhost:4400';

export interface MockState {
  files: Record<string, string | null>;
  log: {
    path: string;
    xsrf?: boolean;
    hadSession?: boolean;
    p?: string;
    repo?: string;
    url?: string;
    name?: string;
    cwd?: string;
    id?: string;
  }[];
  prompts: { conversationId: string; text: string; model: string; effort: string; mode: string; file?: { path: string; startLine?: number; endLine?: number } }[];
  terminals: { id: string; title: string; cwd: string; exited: boolean; inputs: string[]; sizes: [number, number][] }[];
  passkeyCount: number;
  registrationCount: number;
  freshCount: number;
  challengeCount: number;
}

export async function resetMock(request: APIRequestContext): Promise<void> {
  await request.post(`${MOCK_ORIGIN}/__test/reset`);
}

export async function mockState(request: APIRequestContext): Promise<MockState> {
  return (await request.get(`${MOCK_ORIGIN}/__test/state`)).json();
}

export async function setFile(request: APIRequestContext, path: string, content: string): Promise<void> {
  await request.put(`${MOCK_ORIGIN}/__test/file`, { data: { path, content } });
}

/** Sets a repository's ahead/behind in the mock, so a test gets its own push/pull state without a fourth repository. */
export async function setRepoState(
  request: APIRequestContext,
  repo: string,
  state: { ahead?: number; behind?: number }
): Promise<void> {
  await request.post(`${MOCK_ORIGIN}/__test/repo-state`, { data: { repo, ...state } });
}

/** Sets the session inactivity timeout in the mock (seconds), also for already existing sessions. */
export async function setSessionTimeout(request: APIRequestContext, idleSeconds: number): Promise<void> {
  await request.post(`${MOCK_ORIGIN}/__test/session-timeout?idle=${idleSeconds}`);
}

/** Invalidates sessions on the server. By default it also drops console connections, like the real backend. */
export async function killSessions(request: APIRequestContext, options: { keepSockets?: boolean } = {}): Promise<void> {
  await request.post(`${MOCK_ORIGIN}/__test/kill-sessions${options.keepSockets ? '?keepSockets=1' : ''}`);
}

/** Drops hub connections without ending the session (a brief network failure). The client reconnects. */
export async function dropSockets(request: APIRequestContext): Promise<void> {
  await request.post(`${MOCK_ORIGIN}/__test/drop-sockets`);
}

/**
 * Failures in the mock: `dropInputAck` (this many `Input` batches will be accepted without acknowledgment, dropping the connection),
 * `downAfterDropMs` (after such a drop the hubs are unavailable for this many ms), `attachDelayMs` (delay of `Attach`),
 * `hubDownMs` (from now on, for this many ms the hubs reject new connections), `listDelayMs` (delay of `ListTerminals`).
 */
export async function setFault(
  request: APIRequestContext,
  faults: { dropInputAck?: number; downAfterDropMs?: number; attachDelayMs?: number; hubDownMs?: number; listDelayMs?: number }
): Promise<void> {
  const query = new URLSearchParams(Object.entries(faults).map(([key, value]) => [key, String(value)]));
  await request.post(`${MOCK_ORIGIN}/__test/fault?${query}`);
}

/**
 * A pywal `colors.json` as pywal16 writes it (checksum, wallpaper, alpha, special, colors), with upper-case digits, for
 * `setTerminalTheme`.
 */
export const PYWAL_COLORS = JSON.stringify(
  {
    checksum: '9f2c4e1b7a3d5c6e',
    wallpaper: '/srv/wallpapers/morze.jpg',
    alpha: '100',
    special: { background: '#0B0E14', foreground: '#C5C8C6', cursor: '#F0C674' },
    colors: {
      color0: '#0B0E14',
      color1: '#CC6666',
      color2: '#B5BD68',
      color3: '#F0C674',
      color4: '#81A2BE',
      color5: '#B294BB',
      color6: '#8ABEB7',
      color7: '#C5C8C6',
      color8: '#4D5057',
      color9: '#D54E53',
      color10: '#B9CA4A',
      color11: '#E7C547',
      color12: '#7AA6DA',
      color13: '#C397D8',
      color14: '#70C0B1',
      color15: '#EAEAEA'
    }
  },
  null,
  4
);

/** What the API answers for PYWAL_COLORS: its 19 colours in lower case, and nothing else. */
export const PYWAL_THEME = {
  background: '#0b0e14',
  foreground: '#c5c8c6',
  cursor: '#f0c674',
  palette: [
    '#0b0e14', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
    '#4d5057', '#d54e53', '#b9ca4a', '#e7c547', '#7aa6da', '#c397d8', '#70c0b1', '#eaeaea'
  ]
};

/** The text of the pywal file the mock answers `GET /api/terminal/theme` from; null: none (as after a reset). */
export async function setTerminalTheme(request: APIRequestContext, content: string | null): Promise<void> {
  await request.put(`${MOCK_ORIGIN}/__test/terminal-theme`, { data: { content } });
}

/** A colour as the browser computes it: "#0b0e14" → "rgb(11, 14, 20)". */
export function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** A colour token of styles.scss as the page has it, e.g. "--surface". */
export async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);
}

/** Everything that reached the terminal shell (`Input` batches joined in order). */
export async function terminalInputs(request: APIRequestContext, index = 0): Promise<string> {
  return ((await mockState(request)).terminals[index]?.inputs ?? []).join('');
}

/** Pastes text into the active terminal the way the browser would (a `paste` event with the clipboard). */
export async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  await activeTerminal(page)
    .locator('textarea')
    .evaluate((textarea, value) => {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
}

export async function fillLogin(page: Page, overrides: Partial<typeof USER> = {}): Promise<void> {
  const values = { ...USER, ...overrides };
  await page.fill('#userName', values.userName);
  await page.fill('#password', values.password);
  await page.fill('#totpCode', values.totpCode);
  await page.click('button[type=submit]');
}

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await fillLogin(page);
  await page.waitForURL('/');
}

/** Row of the repository table in the Workspace panel. */
export function repoRow(page: Page, name: string): Locator {
  return page.locator('app-workspaces-panel tr.repo').filter({ has: page.locator('.repo__name', { hasText: new RegExp(`^${escape(name)}$`) }) });
}

/** Opens a repository with the "Open" button in Source Control. */
export async function openRepo(page: Page, name: string, workspace = 'Studia'): Promise<void> {
  await showView(page, 'Source Control');
  await page.locator('app-workspaces-panel .workspace', { hasText: workspace }).click();
  await repoRow(page, name).getByRole('button', { name: `Open ${name}` }).click();
  await expect(repoRow(page, name).getByRole('button', { name: `Opened: ${name}` })).toBeVisible();
}

/** Shows the bottom panel (closed at start), whose only tab is the terminal. */
export async function openTerminalTab(page: Page): Promise<void> {
  const panel = page.getByRole('button', { name: 'Panel', exact: true });
  if ((await panel.getAttribute('aria-pressed')) !== 'true') {
    await panel.click();
  }
  await expect(activeTerminal(page).locator('.xterm-rows')).toBeVisible();
}

/** The visible (active) terminal. */
export function activeTerminal(page: Page): Locator {
  return page.locator('app-terminal-view:not(.hidden)');
}

/** Text visible in the active terminal (non-breaking spaces replaced with regular ones). */
export async function terminalText(page: Page): Promise<string> {
  return (await activeTerminal(page).locator('.xterm-rows').innerText()).replace(/\u00a0/g, ' ');
}

export async function expectTerminalToContain(page: Page, text: string): Promise<void> {
  await expect.poll(() => terminalText(page)).toContain(text);
}

/** Types text into the active terminal (focus on the xterm field) and optionally Enter. */
export async function typeInTerminal(page: Page, text: string, enter = true): Promise<void> {
  await activeTerminal(page).locator('.xterm-screen').click();
  await page.keyboard.type(text);
  if (enter) {
    await page.keyboard.press('Enter');
  }
}

/** File explorer row with exactly this name. */
export function treeRow(page: Page, name: string): Locator {
  return page.locator('.row').filter({ has: page.locator('.row__name', { hasText: new RegExp(`^${escape(name)}$`) }) });
}

export async function openFile(page: Page, path: string): Promise<void> {
  await showView(page, 'Explorer');
  const parts = path.split('/');
  for (const part of parts) {
    const row = treeRow(page, part);
    if ((await row.getAttribute('aria-expanded')) !== 'true') {
      await row.click();
    }
  }
}

/** Shows a view of the side bar; on a phone the drawer must be open. */
export async function showView(page: Page, name: 'Explorer' | 'Search' | 'Source Control'): Promise<void> {
  const tab = page.locator('app-side-bar').getByRole('tab', { name, exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.click();
  }
}

/** Searches in files from the Search view (shown first) with Enter; returns the view. */
export async function searchFor(page: Page, query: string): Promise<Locator> {
  await showView(page, 'Search');
  const view = page.locator('app-search-view');
  const field = view.getByRole('textbox', { name: 'Search', exact: true });
  await field.fill(query);
  await field.press('Enter');
  return view;
}

/** Opens the Security window from the account menu of the title bar. */
export async function openSecurity(page: Page): Promise<Locator> {
  await page.locator('.topbar__user').click();
  await page.getByRole('menuitem', { name: 'Security' }).click();
  const security = page.getByRole('dialog', { name: 'Security' });
  await expect(security).toBeVisible();
  return security;
}

/** Logs out from the account menu of the title bar. */
export async function logOut(page: Page): Promise<void> {
  await page.locator('.topbar__user').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
}

/** Text visible in Monaco. Monaco shows spaces as non-breaking spaces (\u00a0), so we normalize them. */
export async function editorText(page: Page): Promise<string> {
  return (await page.locator('.monaco-editor .view-lines').innerText()).replace(/\u00a0/g, ' ');
}

export async function expectEditorToContain(page: Page, text: string): Promise<void> {
  await expect.poll(() => editorText(page)).toContain(text);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The page's virtual authenticator (Chromium's CDP `WebAuthn` domain) and the CDP session that controls it. */
export interface VirtualAuthenticator {
  cdp: CDPSession;
  id: string;
}

/**
 * Gives the page Chromium's virtual authenticator: built in, with discoverable passkeys and user verification, and it
 * answers at once. `synced` marks new passkeys as backup eligible, which the Security window shows as "synced".
 */
export async function addVirtualAuthenticator(page: Page, synced = false): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      defaultBackupEligibility: synced
    }
  });
  return { cdp, id: authenticatorId };
}

/** Adds a passkey in the open Security window of a session that has not re-authenticated yet: name, Add, password and code. */
export async function addPasskey(security: Locator, name: string): Promise<void> {
  await security.getByRole('textbox', { name: 'New passkey name' }).fill(name);
  await security.getByRole('button', { name: 'Add passkey' }).click();
  await security.getByLabel('Password', { exact: true }).fill(USER.password);
  await security.getByLabel('Authenticator code', { exact: true }).fill(USER.totpCode);
  await security.getByRole('button', { name: 'Confirm' }).click();
  await expect(security.locator('tr.passkey [data-label="Name"]', { hasText: name })).toBeVisible();
}
