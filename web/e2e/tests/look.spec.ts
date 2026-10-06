import { expect, test } from './fixtures';
import { MAIN, activeTerminal, expectEditorToContain, login, openFile, openTerminalTab, resetMock, treeRow } from './helpers';

/**
 * The shipped look (docs/ARCHITECTURE.md, "Frontend"): the self-hosted fonts and the icon font are loaded and served as
 * fonts, the terminal's Nerd Font symbols load only when needed, the desktop terminal has its size and padding, and
 * Monaco's own icon font, which loads later, does not change the app's icons.
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
