import { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { MAIN, expectEditorToContain, login, openFile, openTerminalTab, resetMock, terminalText, typeInTerminal } from './helpers';

/**
 * Panels slide in and out with transform only (docs/ARCHITECTURE.md, "Frontend"): the console column and the bottom
 * panel with animations, the side bar with a transition. The project runs with reduced motion; this file also runs
 * with motion.
 */

/** Clicks a title-bar toggle and returns the CSS animations and transitions that run two frames later. */
async function toggle(page: Page, name: 'Console' | 'Panel' | 'Side bar'): Promise<string[]> {
  return page.getByRole('button', { name, exact: true }).evaluate(async (button) => {
    (button as HTMLButtonElement).click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return document
      .getAnimations()
      .map((animation) =>
        animation instanceof CSSTransition ? `transition:${animation.transitionProperty}` : ((animation as CSSAnimation).animationName ?? '')
      );
  });
}

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the console column, the bottom panel and the side bar slide out and in, and the editor and terminal still take keys', async ({ page }) => {
    for (let round = 0; round < 2; round++) {
      expect(await toggle(page, 'Console')).toContain('slide-out-right');
      await expect(page.locator('aside.console')).toHaveCount(0, { timeout: 1000 });
      expect(await toggle(page, 'Console')).toContain('slide-in-right');
      await expect(page.locator('aside.console')).toBeVisible();

      expect(await toggle(page, 'Panel')).toContain('slide-in-up');
      await expect(page.locator('section.bottom')).toBeVisible();
      expect(await toggle(page, 'Panel')).toContain('slide-out-down');
      await expect(page.locator('section.bottom')).toHaveCount(0, { timeout: 1000 });

      expect(await toggle(page, 'Side bar')).toContain('transition:transform');
      await expect(page.locator('app-side-bar')).toBeHidden({ timeout: 1000 });
      expect(await toggle(page, 'Side bar')).toContain('transition:transform');
      await expect(page.locator('app-side-bar')).toBeVisible();
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

test('with reduced motion the console, the bottom panel and the side bar change at once', async ({ page }) => {
  expect(await toggle(page, 'Console')).toEqual([]);
  await expect(page.locator('aside.console')).toHaveCount(0, { timeout: 1000 });
  expect(await toggle(page, 'Panel')).toEqual([]);
  await expect(page.locator('section.bottom')).toBeVisible({ timeout: 1000 });
  expect(await toggle(page, 'Panel')).toEqual([]);
  await expect(page.locator('section.bottom')).toHaveCount(0, { timeout: 1000 });
  expect(await toggle(page, 'Side bar')).toEqual([]);
  await expect(page.locator('app-side-bar')).toBeHidden({ timeout: 1000 });
});
