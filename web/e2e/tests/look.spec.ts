import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  MAIN,
  PYWAL_COLORS,
  PYWAL_THEME,
  activeTerminal,
  expectEditorToContain,
  expectTerminalToContain,
  login,
  openFile,
  openTerminalTab,
  pasteIntoTerminal,
  resetMock,
  rgb,
  setFault,
  setTerminalTheme,
  terminalText,
  token,
  treeRow
} from './helpers';

/**
 * The shipped look (docs/ARCHITECTURE.md, "Frontend"; the terminal's colours: "Terminal" → "Rules"): the self-hosted
 * fonts and the icon font are loaded and served as fonts, the terminal's Nerd Font symbols load only when needed, the
 * desktop terminal has its size and padding, its colours come from the server's theme when there is one and are the
 * portal's otherwise, and Monaco's own icon font, which loads later, does not change the app's icons.
 */

test.beforeEach(async ({ request }) => resetMock(request));

test('the fonts and the icon font are served by the portal and loaded', async ({ page }) => {
  const fontTypes = new Map<string, string>();
  page.on('response', (response) => {
    if (/\.woff2$/.test(new URL(response.url()).pathname)) {
      fontTypes.set(response.url(), response.headers()['content-type'] ?? '');
    }
  });
  await login(page);
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');

  await expect
    .poll(() =>
      page.evaluate(() => ['13px "JetBrains Mono"', '13px "IBM Plex Sans"', '16px codicon'].map((font) => document.fonts.check(font)))
    )
    .toEqual([true, true, true]);
  expect(fontTypes.size).toBeGreaterThan(0);
  expect([...new Set(fontTypes.values())]).toEqual(['font/woff2']);
});

test('the app icons keep their glyphs after Monaco has loaded its own icon font', async ({ page }) => {
  await login(page);
  const icons = [page.locator('.topbar__user .codicon'), treeRow(page, 'prywatne').locator('.codicon')];
  const glyphs = () =>
    Promise.all(
      icons.map((icon) =>
        icon.evaluate((element) => ({
          content: getComputedStyle(element, '::before').content,
          width: element.getBoundingClientRect().width
        }))
      )
    );
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px codicon'))).toBe(true);
  const before = await glyphs();

  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.waitForTimeout(300); // monaco.css and Monaco's icon rules are in place

  expect(await glyphs()).toEqual(before);
});

test('the file icons of the tree load and are served as SVG images', async ({ page }) => {
  const types = new Map<string, string>();
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/file-icons/')) {
      types.set(response.url(), response.headers()['content-type'] ?? '');
    }
  });
  await login(page);
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  const icons = page.locator('app-explorer img.file-icon');
  await expect(icons.first()).toBeVisible();
  const decoded = await icons.evaluateAll((images) =>
    Promise.all(images.map((image) => (image as HTMLImageElement).decode().then(() => true, () => false)))
  );
  expect(decoded.length).toBeGreaterThan(5);
  expect(decoded.every(Boolean)).toBe(true);
  expect(types.size).toBeGreaterThan(0);
  expect([...new Set(types.values())]).toEqual(['image/svg+xml']);
});

test('the terminal ships the Nerd Font symbols as a web font that loads only when needed', async ({ page }) => {
  const types = new Map<string, string>();
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.includes('JetBrainsMonoNerdFont')) {
      types.set(response.url(), response.headers()['content-type'] ?? '');
    }
  });
  await login(page);
  await openTerminalTab(page);
  const status = () =>
    page.evaluate(
      () => [...document.fonts].find((face) => face.family.replace(/"/g, '') === 'JetBrainsMono Nerd Font Web')?.status ?? 'missing'
    );
  expect(await status()).toBe('unloaded');
  expect(types.size).toBe(0);

  const symbol = String.fromCodePoint(0xe0b6);
  await page.evaluate((text) => document.fonts.load('13px "JetBrainsMono Nerd Font Web"', text), symbol);
  expect(await status()).toBe('loaded');
  expect(await page.evaluate((text) => document.fonts.check('13px "JetBrainsMono Nerd Font Web"', text), symbol)).toBe(true);
  expect([...new Set(types.values())]).toEqual(['font/woff2']);
});

test('the desktop terminal uses an 11 pt font with 10 px of padding', async ({ page }) => {
  await login(page);
  await openTerminalTab(page);
  const rows = activeTerminal(page).locator('.xterm-rows');
  await expect(rows).toHaveCSS('font-size', /^14\.66/);
  const view = (await activeTerminal(page).boundingBox())!;
  const xterm = (await activeTerminal(page).locator('.xterm').boundingBox())!;
  expect(Math.round(xterm.x - view.x)).toBe(10);
  expect(Math.round(xterm.y - view.y)).toBe(10);
});

/** The portal's ANSI green (xterm-loader.ts), which the mock's prompt uses (SGR 32). */
const PORTAL_GREEN = '#8fc28f';
const THEME_API = (url: URL) => url.pathname === '/api/terminal/theme';

/** The active terminal has the portal's colours: xterm on `--surface`, no padding colour of its own, the portal's green. */
async function expectPortalColours(page: Page): Promise<void> {
  const terminal = activeTerminal(page);
  await expect(terminal.locator('.xterm-rows span.xterm-fg-2').first()).toHaveCSS('color', rgb(PORTAL_GREEN));
  await expect(terminal.locator('.xterm-scrollable-element')).toHaveCSS('background-color', rgb(await token(page, '--surface')));
  await expect(terminal).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}

test("with a theme from the server, xterm, its padding and the ANSI colours take it, and the paste panel keeps the portal surface", async ({ page, request }) => {
  await setTerminalTheme(request, PYWAL_COLORS);
  await login(page);
  await openTerminalTab(page);
  const terminal = activeTerminal(page);
  await expect(terminal).toHaveCSS('background-color', rgb(PYWAL_THEME.background));
  await expect(terminal.locator('.xterm-scrollable-element')).toHaveCSS('background-color', rgb(PYWAL_THEME.background));
  await expect(terminal.locator('.xterm-rows')).toHaveCSS('color', rgb(PYWAL_THEME.foreground));
  // The mock's prompt: the user in green (SGR 32, ANSI 2) and the directory in blue (SGR 34, ANSI 4).
  await expect(terminal.locator('.xterm-rows span.xterm-fg-2').first()).toHaveCSS('color', rgb(PYWAL_THEME.palette[2]));
  await expect(terminal.locator('.xterm-rows span.xterm-fg-4').first()).toHaveCSS('color', rgb(PYWAL_THEME.palette[4]));

  // The view's panels keep the portal's surface.
  await pasteIntoTerminal(page, 'echo jeden\necho dwa');
  const question = terminal.getByRole('alertdialog');
  await expect(question).toHaveCSS('background-color', rgb(await token(page, '--surface')));
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
});

test('after a reload the terminal is themed before Attach writes the snapshot, its padding included', async ({ page, request }) => {
  await setTerminalTheme(request, PYWAL_COLORS);
  await login(page);
  await openTerminalTab(page);
  await expectTerminalToContain(page, 'owner@dom');

  await setFault(request, { attachDelayMs: 2_000 });
  await page.reload();
  await openTerminalTab(page);
  const terminal = activeTerminal(page);
  await expect(terminal).toHaveCSS('background-color', rgb(PYWAL_THEME.background));
  await expect(terminal.locator('.xterm-scrollable-element')).toHaveCSS('background-color', rgb(PYWAL_THEME.background));
  // Attach is still on its way: nothing of the snapshot is written yet, and the theme is already there.
  expect((await terminalText(page)).trim()).toBe('');
  await expectTerminalToContain(page, 'owner@dom');
  await expect(terminal.locator('.xterm-rows span.xterm-fg-2').first()).toHaveCSS('color', rgb(PYWAL_THEME.palette[2]));
});

test('without a theme, or with a malformed file, the terminal keeps the portal colours', async ({ page, request }) => {
  await login(page);
  await openTerminalTab(page);
  await expectPortalColours(page);

  await setTerminalTheme(request, PYWAL_COLORS.replace('"#B5BD68"', '"#B5BD6"'));
  await page.getByRole('button', { name: 'New terminal' }).click();
  await expect(page.locator('app-terminal-panel .tab__name')).toHaveCount(2);
  await expectPortalColours(page);
});

test('a malformed theme answer leaves the portal colours', async ({ page, request }) => {
  await setTerminalTheme(request, PYWAL_COLORS);
  // Answers the backend never gives, one per terminal: 15 colours, a colour by name, and a page instead of JSON.
  const answers = [
    JSON.stringify({ ...PYWAL_THEME, palette: PYWAL_THEME.palette.slice(0, 15) }),
    JSON.stringify({ ...PYWAL_THEME, cursor: 'red' }),
    '<!doctype html><title>Bad gateway</title>'
  ];
  let asked = 0;
  await page.route(THEME_API, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: answers[asked++] }));
  await login(page);
  await openTerminalTab(page);
  await expectPortalColours(page);
  for (const count of [2, 3]) {
    await page.getByRole('button', { name: 'New terminal' }).click();
    await expect(page.locator('app-terminal-panel .tab__name')).toHaveCount(count);
    await expectPortalColours(page);
  }
  expect(asked).toBe(3);
});

test('a theme request without an answer within 3 s leaves the portal colours, and the terminal still opens', async ({ page, request }) => {
  await setTerminalTheme(request, PYWAL_COLORS);
  let asked = 0;
  await page.route(THEME_API, async (route) => {
    asked++;
    // The mock's theme, but only after the view stopped waiting: it must not reach a terminal already shown.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.continue().catch(() => undefined);
  });
  await login(page);
  await page.getByRole('button', { name: 'Panel', exact: true }).click();
  await expect(activeTerminal(page).locator('.xterm-rows')).toBeVisible({ timeout: 10_000 });
  await expectPortalColours(page);
  expect(asked).toBe(1);
  await page.waitForTimeout(2_500); // the late answer has come and gone
  await expectPortalColours(page);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
