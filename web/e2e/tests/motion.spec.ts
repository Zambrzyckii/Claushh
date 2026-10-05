import { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { MAIN, expectEditorToContain, login, openFile, openTerminalTab, resetMock, terminalText, typeInTerminal } from './helpers';

/**
 * Panels slide in and out with transform only (docs/ARCHITECTURE.md, "Frontend"). The project runs with reduced motion;
 * this file also runs with motion.
 */

/** Clicks a top-bar toggle and returns the names of the animations that run two frames later. */
async function toggle(page: Page, name: 'Console' | 'Panel'): Promise<string[]> {
  return page.getByRole('button', { name, exact: true }).evaluate(async (button) => {
    (button as HTMLButtonElement).click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return document.getAnimations().map((animation) => (animation as CSSAnimation).animationName ?? '');
  });
}

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the console column and the bottom panel slide out and in, and the editor and terminal still take keys', async ({ page }) => {
    for (let round = 0; round < 2; round++) {
      expect(await toggle(page, 'Console')).toContain('slide-out-right');
      await expect(page.locator('aside.console')).toHaveCount(0, { timeout: 1000 });
      expect(await toggle(page, 'Console')).toContain('slide-in-right');
      await expect(page.locator('aside.console')).toBeVisible();

      expect(await toggle(page, 'Panel')).toContain('slide-out-down');
      await expect(page.locator('section.bottom')).toHaveCount(0, { timeout: 1000 });
      expect(await toggle(page, 'Panel')).toContain('slide-in-up');
      await expect(page.locator('section.bottom')).toBeVisible();
    }

    await openFile(page, MAIN);
    await expectEditorToContain(page, 'int main');
    await page.locator('.monaco-editor .view-lines').click();
    await page.keyboard.type('// ruch');
    await expectEditorToContain(page, '// ruch');
    await openTerminalTab(page);
    await typeInTerminal(page, 'echo ruch');
    await expect.poll(() => terminalText(page)).toMatch(/^ruch\s*$/m);
  });
});

test('with reduced motion a closed console and bottom panel leave at once', async ({ page }) => {
  expect(await toggle(page, 'Console')).toEqual([]);
  await expect(page.locator('aside.console')).toHaveCount(0, { timeout: 1000 });
  expect(await toggle(page, 'Panel')).toEqual([]);
  await expect(page.locator('section.bottom')).toHaveCount(0, { timeout: 1000 });
});
