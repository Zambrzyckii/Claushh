/**
 * Default Trusted Types policy (CSP `require-trusted-types-for 'script'` in `index.html`).
 *
 * With this directive the browser rejects plain strings inserted as HTML (`innerHTML`), script or script URL,
 * so a possible DOM XSS bug will not execute code. Angular and Monaco have their own policies. This policy handles
 * only Monaco worker script URLs (`new Worker(new URL(...))`, the bundler requires exactly this form):
 * it lets through only `.js` files from the root directory of the same origin, without parameters. The only exception is in
 * development mode (`ng serve`): Vite appends exactly `?worker_file&type=module` to the worker URL.
 * HTML and scripts from strings are still blocked. Description: docs/ARCHITECTURE.md, section "Security headers".
 */

import { isDevMode } from '@angular/core';

/** Parameter that the development server (Vite) appends to worker URLs. */
const DEV_WORKER_QUERY = '?worker_file&type=module';

interface TrustedTypePolicyFactory {
  createPolicy(name: string, rules: { createScriptURL?: (value: string) => string }): unknown;
}

export function installTrustedTypesPolicy(): void {
  const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
  if (!factory) {
    return; // browser without Trusted Types: the CSP directive enforces nothing anyway
  }
  factory.createPolicy('default', {
    createScriptURL: (value) => {
      const url = new URL(value, document.baseURI);
      const query = url.search === '' || (isDevMode() && url.search === DEV_WORKER_QUERY);
      if (url.origin === location.origin && /^\/[\w.-]+\.js$/.test(url.pathname) && query && !url.hash) {
        return url.href;
      }
      throw new TypeError(`Trusted Types: blocked script URL ${value}`);
    }
  });
}
