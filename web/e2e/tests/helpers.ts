import { APIRequestContext, Locator, Page, expect } from '@playwright/test';

/** Data and paths from the mock backend (e2e/mock-api/server.mjs). */
export const USER = { userName: 'owner', password: 'secret', totpCode: '123456' };
export const MAIN = 'studia/lab-3-sieci/src/main.c';
export const LAB = 'studia/lab-3-sieci';
export const BAZY_SQL = 'studia/bazy-danych-lab/zadanie4.sql';

export interface MockState {
  files: Record<string, string | null>;
  log: { path: string; xsrf?: boolean; hadSession?: boolean; p?: string; repo?: string; url?: string; name?: string }[];
  prompts: { conversationId: string; text: string; model: string; effort: string; mode: string }[];
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

/** Invalidates sessions on the server. By default it also drops console connections, like the real backend. */
export async function killSessions(request: APIRequestContext, options: { keepSockets?: boolean } = {}): Promise<void> {
  await request.post(options.keepSockets ? '/__test/kill-sessions?keepSockets=1' : '/__test/kill-sessions');
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

/** Text visible in Monaco. Monaco shows spaces as  , so we normalize them. */
export async function editorText(page: Page): Promise<string> {
  return (await page.locator('.monaco-editor .view-lines').innerText()).replace(/ /g, ' ');
}

export async function expectEditorToContain(page: Page, text: string): Promise<void> {
  await expect.poll(() => editorText(page)).toContain(text);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
