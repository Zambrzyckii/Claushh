import type { FitAddon } from '@xterm/addon-fit';
import type { ITerminalOptions, ITheme, Terminal } from '@xterm/xterm';

import type { TerminalTheme } from './terminal-theme-api';
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

/**
 * The device's own Nerd Font first; then the shipped JetBrains Mono; then the shipped Nerd Font symbols (`styles.scss`),
 * which the browser downloads only for a character JetBrains Mono lacks (the dotfiles prompt's icons, box drawing).
 */
export const TERMINAL_FONT =
  "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'JetBrainsMono Nerd Font Web', ui-monospace, monospace";

/** 11 pt in CSS px, the size of a desktop terminal; a phone keeps 13 px for its columns. */
const DESKTOP_FONT_SIZE = (11 * 96) / 72;

/** xterm's names of the 16 ANSI colours, 0 to 15. */
const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;

/** The portal's own 16 ANSI colors, for a terminal without a theme from the server. */
const PORTAL_ANSI: ITheme = {
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
};

/**
 * Terminal appearance, read when a terminal is created. `theme`: the server's (pywal's) colors, which give the
 * background, the foreground, the cursor and the 16 ANSI colors; without one they come from the tokens of
 * `web/src/styles.scss` and the 16 ANSI colors above. The selection always comes from the token `--editor-selection`.
 * `phone`: the phone layout's smaller font. The line height adds about a pixel to the font's own, and bold text keeps
 * its color instead of turning bright, as in a desktop terminal.
 *
 * Deliberately without clipboard addons (OSC 52): a program in the terminal cannot write anything to the browser clipboard.
 */
export function terminalOptions(phone: boolean, theme: TerminalTheme | null): ITerminalOptions {
  const background = theme?.background ?? cssToken('--surface');
  return {
    fontFamily: TERMINAL_FONT,
    fontSize: phone ? 13 : DESKTOP_FONT_SIZE,
    lineHeight: 1.05,
    cursorBlink: false,
    drawBoldTextInBrightColors: false,
    scrollback: 5000,
    allowProposedApi: false,
    theme: {
      background,
      foreground: theme?.foreground ?? cssToken('--text'),
      cursor: theme?.cursor ?? cssToken('--accent'),
      cursorAccent: background,
      selectionBackground: cssToken('--editor-selection'),
      ...(theme ? ansiColours(theme.palette) : PORTAL_ANSI)
    }
  };
}

/** A palette's 16 colors under xterm's names. */
function ansiColours(palette: readonly string[]): ITheme {
  const colours: ITheme = {};
  ANSI_NAMES.forEach((name, i) => {
    colours[name] = palette[i];
  });
  return colours;
}

/**
 * A new terminal with its fit addon loaded, OSC 8 links disabled and terminal queries left to tmux (docs/ARCHITECTURE.md,
 * section "Terminal", "Rules"). The caller opens it.
 */
export function createTerminal(xterm: XtermModules, phone: boolean, theme: TerminalTheme | null): { term: Terminal; fit: FitAddon } {
  const term = new xterm.Terminal(terminalOptions(phone, theme));
  const fit = new xterm.FitAddon();
  term.loadAddon(fit);
  // OSC 8 links disabled: the visible text ("https://github.com/…") could lead somewhere else.
  // A handler that returns `true` takes over the sequence, so xterm does not create a link. The text itself is displayed.
  term.parser.registerOscHandler(8, () => true);
  // Terminal queries (device attributes, cursor position, modes, colours) are left to tmux on the server: it
  // answers the cursor position report, the mode report and the colour queries, and passes every query on to every
  // view, so xterm answering too would type one more reply per open tab into the program (e.g. "^[[<row>;<col>R"
  // in vim). Device attributes get no answer at all (tmux does not answer them either), which is accepted: an
  // answer from the view would have the same per-tab duplication problem. A handler that returns `true` takes the
  // sequence over, so xterm sends nothing.
  const queries = [
    { final: 'c' },
    { prefix: '>', final: 'c' },
    { final: 'n' },
    { prefix: '?', final: 'n' },
    { intermediates: '$', final: 'p' },
    { prefix: '?', intermediates: '$', final: 'p' }
  ];
  for (const query of queries) {
    term.parser.registerCsiHandler(query, () => true);
  }
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
  // Colour queries ("?") only: setting a colour still works.
  for (const colour of [4, 10, 11, 12]) {
    term.parser.registerOscHandler(colour, (data) => data.split(';').includes('?'));
  }
  return { term, fit };
}
