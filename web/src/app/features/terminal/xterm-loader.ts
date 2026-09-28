import type { FitAddon } from '@xterm/addon-fit';
import type { ITerminalOptions, Terminal } from '@xterm/xterm';

/**
 * Lazy loading of xterm.js (only when the Terminal tab is first opened).
 * xterm styles are in the global styles (`angular.json` → `styles`), because they are small.
 */

export interface XtermModules {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
}

let loading: Promise<XtermModules> | null = null;

export function loadXterm(): Promise<XtermModules> {
  loading ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([xterm, fit]) => ({
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon
  }));
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * Terminal appearance matching the tokens from `web/src/styles.scss`. The Nerd Font font comes first,
 * so that the icons from the dotfiles prompt are displayed if it is installed on the system.
 *
 * Deliberately without clipboard addons (OSC 52): a program in the terminal cannot write anything to the browser clipboard.
 */
export const TERMINAL_OPTIONS: ITerminalOptions = {
  fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: false,
  scrollback: 5000,
  allowProposedApi: false,
  theme: {
    background: '#16171a',
    foreground: '#d6d6d0',
    cursor: '#e0a458',
    cursorAccent: '#16171a',
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
