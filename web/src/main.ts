import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { installTrustedTypesPolicy } from './app/core/browser/trusted-types';

// The portal must not run in a frame of a foreign page (clickjacking). The real protection is the CSP header
// `frame-ancestors 'none'` from the backend, this is only a fallback in case it is missing.
if (window.top !== window.self) {
  document.body.textContent = 'This page cannot be shown in a frame.';
} else {
  installTrustedTypesPolicy();
  bootstrapApplication(App, appConfig).catch((err) => console.error(err));
}
