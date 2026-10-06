import { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  MAIN,
  PASSKEY_ORIGIN,
  USER,
  activeTerminal,
  addPasskey,
  addVirtualAuthenticator,
  expectEditorToContain,
  login,
  mockState,
  openFile,
  repoRow,
  resetMock,
  setSessionTimeout,
  terminalInputs,
  terminalText,
  treeRow,
  typeInTerminal
} from './helpers';

/**
 * The phone layout (docs/ARCHITECTURE.md, "Frontend" → "Phone layout"), in the Pixel 7 project: the tabs Editor ·
 * Terminal · Console, the explorer drawer, the sheets, the menu, the condensed bars.
 */

test.beforeEach(async ({ request }) => resetMock(request));

const tab = (page: Page, name: 'Editor' | 'Terminal' | 'Console') => page.getByRole('tab', { name, exact: true });
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('a phone gets the phone layout, the login fits, no tab scrolls sideways, and no panel has an edge', async ({ page }) => {
  const phone = page.viewportSize()!;
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/login');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  await expect(page.locator('#userName')).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.setViewportSize(phone);

  await login(page);
  await expect(tab(page, 'Editor')).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Editor', 'Terminal', 'Console'] as const) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    expect(await noSidewaysScroll(page)).toBe(true);
  }
  await expect(page.getByRole('separator', { name: /^Resize / })).toHaveCount(0);
  await expect(page.locator('app-phone-panes .tabbar')).not.toContainText(/claude/i);
  await expect(page.locator('.topbar')).not.toContainText(/claude/i);
});

test('the explorer drawer opens a file and closes, and Save writes it', async ({ page, request }) => {
  await login(page);
  const drawer = page.locator('.drawer');
  await page.getByRole('button', { name: 'Explorer' }).click();
  await expect(drawer).toHaveClass(/drawer--open/);
  await openFile(page, MAIN);
  await expect(drawer).not.toHaveClass(/drawer--open/);
  await expectEditorToContain(page, 'int main');

  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// phone\n');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  expect((await mockState(request)).files[MAIN]).toMatch(/^\/\/ phone\n#include/);
});

test('OPEN EDITORS in the drawer switches the file and closes the drawer, and the phone has no minimap', async ({ page }) => {
  await login(page);
  const explorer = page.getByRole('button', { name: 'Explorer' });
  await explorer.click();
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await explorer.click();
  await treeRow(page, 'parser.c').click();
  await expectEditorToContain(page, 'int parse');

  await explorer.click();
  const section = page.locator('app-open-editors');
  await section.getByRole('button', { name: 'Open Editors' }).click();
  await section.locator('.open-editor__name', { hasText: 'main.c' }).click();
  await expect(page.locator('.drawer')).not.toHaveClass(/drawer--open/);
  await expectEditorToContain(page, 'int main');
  await expect(page.locator('.monaco-editor .minimap')).toBeHidden();
});

test('the Search button opens the drawer on Search, and a result opens the file and closes the drawer', async ({ page }) => {
  await login(page);
  const search = page.getByRole('button', { name: 'Search', exact: true });
  await search.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toHaveClass(/drawer--open/);
  await expect(drawer.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
  const field = drawer.getByRole('textbox', { name: 'Search', exact: true });
  await expect(field).toBeFocused();
  await field.fill('parse');
  await field.press('Enter');
  await drawer.locator('.search-match', { hasText: 'int parse(void)' }).click();
  await expect(drawer).not.toHaveClass(/drawer--open/);
  await expectEditorToContain(page, 'int parse');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
});

test('switching tabs keeps the editor and its unsaved text, and the terminal mounts once on its first visit', async ({ page, request }) => {
  await login(page);
  await page.getByRole('button', { name: 'Explorer' }).click();
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('// draft');
  await page.locator('.monaco-editor').first().evaluate((editor) => editor.setAttribute('data-probe', 'kept'));
  expect((await mockState(request)).terminals).toHaveLength(0);

  await tab(page, 'Terminal').click();
  await typeInTerminal(page, 'echo telefon');
  await expect.poll(() => terminalText(page)).toMatch(/^telefon\s*$/m);
  await expect(activeTerminal(page).locator('.xterm-rows')).toHaveCSS('font-size', '13px');
  await activeTerminal(page).locator('.xterm').evaluate((node) => node.setAttribute('data-probe', 'kept'));
  await tab(page, 'Console').click();
  await expect(page.locator('#phone-pane-editor')).toHaveAttribute('inert', '');
  await expect(page.locator('#phone-pane-terminal')).toHaveAttribute('inert', '');
  expect(await page.locator('#phone-pane-console').getAttribute('inert')).toBeNull();
  await tab(page, 'Editor').click();

  await expect(page.locator('.monaco-editor[data-probe="kept"]')).toHaveCount(1);
  await expectEditorToContain(page, '// draft');
  await expect(page.locator('.tab__dirty')).toBeVisible();
  await tab(page, 'Terminal').click();
  await expect(activeTerminal(page).locator('.xterm-rows')).toBeVisible();
  await expect(activeTerminal(page).locator('.xterm[data-probe="kept"]')).toHaveCount(1);
  expect((await mockState(request)).terminals).toHaveLength(1);
});

test('in the console Enter makes a new line and Send sends', async ({ page, request }) => {
  await login(page);
  await tab(page, 'Console').click();
  const panel = page.locator('app-console-panel');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.click();
  await page.keyboard.type('dodaj');
  await page.keyboard.press('Enter');
  await page.keyboard.type('komentarz');
  await expect(prompt).toHaveValue('dodaj\nkomentarz');
  expect((await mockState(request)).prompts).toHaveLength(0);

  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel).toContainText('Gotowe.');
  expect((await mockState(request)).prompts.map((sent) => sent.text)).toEqual(['dodaj\nkomentarz']);
  await expect(panel.getByRole('button', { name: 'Hide' })).toHaveCount(0);
});

test('the Console tab names the file open in the Editor tab and sends it', async ({ page, request }) => {
  await login(page);
  await page.getByRole('button', { name: 'Explorer' }).click();
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await tab(page, 'Console').click();
  const panel = page.locator('app-console-panel');
  await expect(panel.locator('.file-chip')).toHaveText('main.c');
  await panel.getByRole('button', { name: 'Detach main.c' }).click();
  const attach = panel.getByRole('button', { name: 'Attach main.c' });
  expect((await attach.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  await attach.click();
  await expect(panel.locator('.file-chip')).toHaveText('main.c');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('dodaj komentarz');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('.prompt__file')).toHaveText(`⧉ ${MAIN}`);
  expect((await mockState(request)).prompts[0].file).toEqual({ path: MAIN });
});

test('on a touch screen the fields have 16 px text, so iOS does not zoom, and keep their heights', async ({ page }) => {
  const fontSize = (field: Locator) => field.evaluate((element) => getComputedStyle(element).fontSize);
  await page.goto('/login');
  const user = page.locator('#userName');
  expect(await fontSize(user)).toBe('16px');
  expect((await user.boundingBox())!.height).toBeCloseTo(36, 0);

  await login(page);
  await tab(page, 'Console').click();
  expect(await fontSize(page.getByRole('textbox', { name: 'Prompt' }))).toBe('16px');
  expect(await fontSize(page.getByLabel('model'))).toBe('16px');

  await tab(page, 'Editor').click();
  await page.locator('.topbar__repo-button').click();
  const drawer = page.locator('.drawer');
  await drawer.getByRole('button', { name: 'New workspace' }).click();
  const name = drawer.getByRole('textbox', { name: 'New workspace name' });
  expect(await fontSize(name)).toBe('16px');
  expect((await name.boundingBox())!.height).toBeCloseTo(28, 0);
});

test('the repository button opens Source Control in the drawer, whose repositories are cards, and opening one closes it', async ({ page }) => {
  await login(page);
  const repository = page.locator('.topbar__repo-button');
  await repository.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toHaveClass(/drawer--open/);
  await expect(repository).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.getByRole('tab', { name: 'Source Control' })).toHaveAttribute('aria-selected', 'true');
  await expect(repoRow(page, 'lab-3-sieci')).toBeVisible();
  expect(await repoRow(page, 'lab-3-sieci').evaluate((row) => getComputedStyle(row).display)).toBe('block');

  await repoRow(page, 'lab-3-sieci').getByRole('button', { name: 'Open lab-3-sieci' }).click();
  await expect(drawer).not.toHaveClass(/drawer--open/);
  await expect(page.locator('.topbar__repo')).toHaveText('lab-3-sieci');
  await expect(page.locator('.topbar__branch')).toHaveText('main');
});

test('the menu opens Security as a full-width sheet, closes on Esc, and logs out', async ({ page }) => {
  await login(page);
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitem', { name: 'Security' }).click();
  const security = page.getByRole('dialog', { name: 'Security' });
  await expect(security).toBeVisible();
  expect((await security.boundingBox())!.width).toBeCloseTo(page.viewportSize()!.width, 0);
  await expect(security.locator('tr.session')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(security).toBeHidden();

  await menu.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await menu.click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/login?logout=ok');
});

test('the countdown shows minutes and seconds, and Extend extends', async ({ page, request }) => {
  await setSessionTimeout(request, 100);
  await login(page);
  const timer = page.getByRole('timer');
  await expect(timer).toHaveText(/^\s*1:(3\d|40)\s*$/);
  await expect(timer).toHaveAttribute('aria-label', /^Session expires in 1:/);
  await page.getByRole('button', { name: 'Extend' }).click();
  await expect.poll(async () => (await mockState(request)).log.filter((entry) => entry.path === 'keepalive').length).toBe(1);
});

test('a phone in landscape keeps the phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 839, height: 412 });
  await login(page);
  await expect(tab(page, 'Editor')).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});

test('the extra keys send Esc, Tab, an arrow and a sticky Ctrl, and keep the focus in the terminal', async ({ page, request }) => {
  await login(page);
  await tab(page, 'Terminal').click();
  const terminal = activeTerminal(page);
  await terminal.locator('.xterm-screen').click();
  const keys = terminal.getByRole('toolbar', { name: 'Terminal keys' });
  await keys.getByRole('button', { name: 'Esc' }).tap();
  await keys.getByRole('button', { name: 'Tab' }).tap();
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
  await keys.getByRole('button', { name: 'Up' }).tap();
  const ctrl = keys.getByRole('button', { name: 'Ctrl' });
  await ctrl.tap();
  await expect(ctrl).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('c');
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => terminalInputs(request)).toBe('\x1b\t\x1b[A\x03');
});

test('the Paste key pastes through the same check as a paste', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await tab(page, 'Terminal').click();
  const terminal = activeTerminal(page);
  await terminal.locator('.xterm-screen').click();
  await page.evaluate(() => navigator.clipboard.writeText('echo jeden\necho dwa\n'));
  await terminal.getByRole('toolbar', { name: 'Terminal keys' }).getByRole('button', { name: 'Paste' }).tap();
  const question = terminal.getByRole('alertdialog');
  await expect(question).toContainText('The pasted text has 2 line breaks');
  await question.getByRole('button', { name: 'Paste' }).click();
  await expect.poll(() => terminalText(page)).toMatch(/^jeden\s*$/m);
  await expect.poll(() => terminalText(page)).toMatch(/^dwa\s*$/m);
});

test('a long paste keeps the decision above the keys, and the keys wait for it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await tab(page, 'Terminal').click();
  const terminal = activeTerminal(page);
  await terminal.locator('.xterm-screen').click();
  await page.evaluate(() =>
    navigator.clipboard.writeText(Array.from({ length: 20 }, (_, i) => `echo ${i} ${'x'.repeat(150)}`).join('\n'))
  );
  const keys = terminal.getByRole('toolbar', { name: 'Terminal keys' });
  await keys.getByRole('button', { name: 'Paste' }).tap();
  const question = terminal.getByRole('alertdialog');
  const paste = question.getByRole('button', { name: 'Paste' });
  await paste.scrollIntoViewIfNeeded();
  const button = (await paste.boundingBox())!;
  const row = (await keys.boundingBox())!;
  expect(button.y + button.height).toBeLessThanOrEqual(row.y);
  await expect(keys.getByRole('button', { name: 'Esc' })).toBeDisabled();
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  await expect(keys.getByRole('button', { name: 'Esc' })).toBeEnabled();
});

test.describe('passkeys at localhost', () => {
  test.use({ baseURL: PASSKEY_ORIGIN });

  test('the Security sheet adds a passkey after the password and code and shows it as a card', async ({ page }) => {
    await login(page);
    await addVirtualAuthenticator(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Security' }).click();
    const security = page.getByRole('dialog', { name: 'Security' });
    await security.getByRole('textbox', { name: 'New passkey name' }).fill('Phone');
    await security.getByRole('button', { name: 'Add passkey' }).click();
    const password = security.getByLabel('Password', { exact: true });
    await expect(password).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true); // the password and code form fits the sheet
    await password.fill(USER.password);
    await security.getByLabel('Authenticator code', { exact: true }).fill(USER.totpCode);
    await security.getByRole('button', { name: 'Confirm' }).click();
    await expect(security.locator('tr.passkey [data-label="Name"]', { hasText: 'Phone' })).toBeVisible();
    const card = security.locator('tr.passkey');
    expect(await card.evaluate((row) => getComputedStyle(row).display)).toBe('block');
    await expect(card.locator('[data-label="Sync"]')).toHaveText('this device only');
    await expect(card.getByRole('button', { name: 'Remove passkey Phone' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  });

  test('at 375 px the login screen logs in with a passkey', async ({ page }) => {
    await login(page);
    await addVirtualAuthenticator(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Security' }).click();
    await addPasskey(page.getByRole('dialog', { name: 'Security' }), 'Phone');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL('/login?logout=ok');

    await page.setViewportSize({ width: 375, height: 667 });
    const passkey = page.getByRole('button', { name: 'Log in with a passkey' });
    await expect(passkey).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await passkey.click();
    await expect(tab(page, 'Editor')).toHaveAttribute('aria-selected', 'true');
  });
});
