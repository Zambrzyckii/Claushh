import type { FitAddon } from '@xterm/addon-fit';
import type { ITerminalOptions, Terminal } from '@xterm/xterm';

import { monoFontReady } from '../../core/browser/fonts';
import { cssToken } from '../../core/browser/theme';

/**
 * Lazy loading of xterm.js (only when the Terminal tab is first opened), after JetBrains Mono: xterm measures its cell
 * once when it opens. xterm styles are in the global styles (`angular.json` → `styles`), because they are small.
 */

export interface XtermModules {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
}

let loading: Promise<XtermModules> | null = null;

export function loadXterm(): Promise<XtermModules> {
  loading ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), monoFontReady()]).then(([xterm, fit]) => ({
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon
  }));
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** The Nerd Font first, so that the icons from the dotfiles prompt show when the device has it. */
export const TERMINAL_FONT = "'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace";

/**
 * Terminal appearance from the tokens of `web/src/styles.scss`, read when a terminal is created; the selection and the
 * 16 ANSI colors stay fixed here.
 *
 * Deliberately without clipboard addons (OSC 52): a program in the terminal cannot write anything to the browser clipboard.
 */
export function terminalOptions(): ITerminalOptions {
  const surface = cssToken('--surface');
  return {
    fontFamily: TERMINAL_FONT,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: false,
    scrollback: 5000,
    allowProposedApi: false,
    theme: {
      background: surface,
      foreground: cssToken('--text'),
      cursor: cssToken('--accent'),
      cursorAccent: surface,
      selectionBackground: '#2c3a52',
      black: '#1b1c20',
      red: '#d8836b',
      green: '#8fc28f',
      yellow: '#e0a458',
      blue: '#7fb4d8',
      magenta: '#c49bd6',
      cyan: '#7fc4c4',
      white: '#d6d6d0',
      brightBlack: '#6c6f78',
      brightRed: '#e59a85',
      brightGreen: '#a6d1a6',
      brightYellow: '#ecbd7f',
      brightBlue: '#9cc6e4',
      brightMagenta: '#d4b3e2',
      brightCyan: '#9ad6d6',
      brightWhite: '#f0eee6'
    }
  };
}
