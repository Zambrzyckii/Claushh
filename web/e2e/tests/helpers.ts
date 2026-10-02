import { APIRequestContext, Locator, Page, expect } from '@playwright/test';

/** Data and paths from the mock backend (e2e/mock-api/server.mjs). */
export const USER = { userName: 'owner', password: 'secret', totpCode: '123456' };
export const MAIN = 'studia/lab-3-sieci/src/main.c';
export const LAB = 'studia/lab-3-sieci';
export const BAZY_SQL = 'studia/bazy-danych-lab/zadanie4.sql';

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
  prompts: { conversationId: string; text: string; model: string; effort: string; mode: string }[];
  terminals: { id: string; title: string; cwd: string; exited: boolean; inputs: string[]; sizes: [number, number][] }[];
}

export async function resetMock(request: APIRequestContext): Promise<void> {
  await request.post('/__test/reset');
}

export async function mockState(request: APIRequestContext): Promise<MockState> {
  return (await request.get('/__test/state')).json();
}

export async function setFile(request: APIRequestContext, path: string, content: string): Promise<void> {
  await request.put('/__test/file', { data: { path, content } });
}

/** Sets a repository's ahead/behind in the mock, so a test gets its own push/pull state without a fourth repository. */
export async function setRepoState(
  request: APIRequestContext,
  repo: string,
  state: { ahead?: number; behind?: number }
): Promise<void> {
  await request.post('/__test/repo-state', { data: { repo, ...state } });
}

/** Sets the session inactivity timeout in the mock (seconds), also for already existing sessions. */
export async function setSessionTimeout(request: APIRequestContext, idleSeconds: number): Promise<void> {
  await request.post(`/__test/session-timeout?idle=${idleSeconds}`);
}

/** Invalidates sessions on the server. By default it also drops console connections, like the real backend. */
export async function killSessions(request: APIRequestContext, options: { keepSockets?: boolean } = {}): Promise<void> {
  await request.post(options.keepSockets ? '/__test/kill-sessions?keepSockets=1' : '/__test/kill-sessions');
}

/** Drops hub connections without ending the session (a brief network failure). The client reconnects. */
export async function dropSockets(request: APIRequestContext): Promise<void> {
  await request.post('/__test/drop-sockets');
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
  await request.post(`/__test/fault?${query}`);
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

/** Opens a repository with the "Otwórz" (Open) button in the Workspace panel. */
export async function openRepo(page: Page, name: string, workspace = 'Studia'): Promise<void> {
  await page.locator('app-workspaces-panel .workspace', { hasText: workspace }).click();
  await repoRow(page, name).getByRole('button', { name: `Otwórz ${name}` }).click();
  await expect(repoRow(page, name).getByRole('button', { name: `Otwarte: ${name}` })).toBeVisible();
}

/** Opens the Terminal tab in the bottom panel. */
export async function openTerminalTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'TERMINAL' }).click();
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
  const parts = path.split('/');
  for (const part of parts) {
    const row = treeRow(page, part);
    if ((await row.getAttribute('aria-expanded')) !== 'true') {
      await row.click();
    }
  }
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
