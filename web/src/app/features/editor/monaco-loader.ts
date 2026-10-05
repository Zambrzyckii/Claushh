import type * as MonacoApi from 'monaco-editor';

import { monoFontReady, onFontsLoaded } from '../../core/browser/fonts';
import { cssToken } from '../../core/browser/theme';

/**
 * Lazy loading of Monaco (a few MB) only when the editor is first opened,
 * so that the login screen and the rest of the app load quickly.
 *
 * Monaco is built into the app by the Angular bundler (ESM build, no CDN).
 * Web workers (background highlighting, suggestions for TS/JSON/CSS/HTML) are in `./workers/`
 * and have a separate tsconfig: `web/tsconfig.worker.json`.
 */

export type Monaco = typeof MonacoApi;

let loading: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
  loading ??= (async () => {
    (self as unknown as { MonacoEnvironment: MonacoApi.Environment }).MonacoEnvironment = {
      getWorker(_workerId: string, label: string): Worker {
        switch (label) {
          case 'json':
            return new Worker(new URL('./workers/json.worker', import.meta.url), { type: 'module' });
          case 'css':
          case 'scss':
          case 'less':
            return new Worker(new URL('./workers/css.worker', import.meta.url), { type: 'module' });
          case 'html':
          case 'handlebars':
          case 'razor':
            return new Worker(new URL('./workers/html.worker', import.meta.url), { type: 'module' });
          case 'typescript':
          case 'javascript':
            return new Worker(new URL('./workers/ts.worker', import.meta.url), { type: 'module' });
          default:
            return new Worker(new URL('./workers/editor.worker', import.meta.url), { type: 'module' });
        }
      }
    };
    const [monaco] = await Promise.all([
      import('monaco-editor') as unknown as Promise<Monaco>,
      loadStylesheet(MONACO_STYLESHEET),
      monoFontReady()
    ]);
    defineTheme(monaco);
    // A font that arrives after the editor measured its cells (e.g. the bold face) needs a new measurement.
    onFontsLoaded(() => monaco.editor.remeasureFonts());
    return monaco;
  })();
  // A failed load (e.g. a dropped connection) does not block the next attempt.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * Monaco styles (with a built-in icon font). The Angular bundler does not include CSS imported
 * by lazily loaded modules, so the file is a separate, non-injected stylesheet
 * (`angular.json` → `styles`, `bundleName: "monaco"`) and we add it here ourselves.
 */
const MONACO_STYLESHEET = 'monaco.css';

function loadStylesheet(href: string): Promise<void> {
  if (document.querySelector(`link[data-monaco][href="${href}"]`)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset['monaco'] = '';
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error(`Could not load ${href}`));
    };
    document.head.appendChild(link);
  });
}

export const MONACO_THEME = 'claushh-dark';

/** Theme from the tokens of `web/src/styles.scss`; only the syntax colors and the selection are fixed here. */
function defineTheme(monaco: Monaco): void {
  monaco.editor.defineTheme(MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c49bd6' },
      { token: 'type', foreground: '7fb4d8' },
      { token: 'string', foreground: 'b9c98a' },
      { token: 'number', foreground: 'e0a458' },
      { token: 'comment', foreground: '6c6f78', fontStyle: 'italic' },
      { token: 'delimiter', foreground: 'a9abb3' }
    ],
    colors: {
      'editor.background': cssToken('--bg'),
      'editor.foreground': cssToken('--text'),
      'editor.lineHighlightBackground': cssToken('--hover'),
      'editorLineNumber.foreground': cssToken('--text-faint'),
      'editorLineNumber.activeForeground': cssToken('--text'),
      'editorCursor.foreground': cssToken('--accent'),
      'editor.selectionBackground': '#2c3a52',
      'editorWidget.background': cssToken('--surface'),
      'editorWidget.border': cssToken('--border-strong'),
      focusBorder: cssToken('--accent')
    }
  });
}
