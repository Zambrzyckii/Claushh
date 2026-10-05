import { BrowserContext, Page, test as base, expect } from '@playwright/test';

/**
 * `test` for all e2e files. After each test it checks that no page reported a violation of
 * Content-Security-Policy or Trusted Types, an unhandled exception (including one caught by Angular's ErrorHandler)
 * or a failed Monaco worker creation, in the test context and in the contexts from `newDevice`.
 * This way the whole app (Monaco, xterm, SignalR, forms) is tested under the same CSP policy
 * as in production. A test that deliberately causes a violation (e.g. embedding in a frame) sets
 * `test.use({ allowCspViolations: true })`.
 */
export const test = base.extend<{
  allowCspViolations: boolean;
  problems: string[];
  pageChecks: void;
  /** A new browser with separate cookies ("second device"), with the project's device options, also under CSP checks. */
  newDevice: () => Promise<Page>;
}>({
  allowCspViolations: [false, { option: true }],
  problems: async ({}, use) => {
    await use([]);
  },
  pageChecks: [
    async ({ context, problems, allowCspViolations }, use) => {
      watch(context, problems, allowCspViolations);
      await use();
      expect(problems, 'CSP violations and unhandled exceptions on the page').toEqual([]);
    },
    { auto: true }
  ],
  newDevice: async ({ browser, baseURL, problems, allowCspViolations, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, reducedMotion }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, reducedMotion });
      contexts.push(context);
      watch(context, problems, allowCspViolations);
      return context.newPage();
    });
    for (const context of contexts) {
      await context.close();
    }
  }
});

function watch(context: BrowserContext, problems: string[], allowCspViolations: boolean): void {
  context.on('console', (message) => {
    if (!allowCspViolations && message.type() === 'error' && /Content Security Policy|Trusted ?(Type|HTML|Script)/i.test(message.text())) {
      problems.push(`CSP: ${message.text()}`);
    }
    // After a failed worker creation (e.g. the Trusted Types policy rejected the URL), Monaco only warns and runs slower.
    if (message.type() === 'warning' && /web worker/i.test(message.text())) {
      problems.push(`Worker: ${message.text()}`);
    }
    // Angular catches unhandled exceptions and rejected promises (provideBrowserGlobalErrorListeners), so
    // the browser does not report them. The default ErrorHandler prints them as `console.error('ERROR', …)`.
    if (message.type() === 'error' && message.text().startsWith('ERROR')) {
      problems.push(`App error: ${message.text()}`);
    }
  });
  context.on('weberror', (error) => problems.push(`Unhandled exception: ${error.error().message}`));
}

export { expect };
