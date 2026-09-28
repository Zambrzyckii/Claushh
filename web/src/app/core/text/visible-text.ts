import { countLabel } from './polish';

/**
 * Shows characters that are normally invisible but can change the meaning of the text: control characters,
 * text direction characters (e.g. U+202E reverses the order), zero-width characters, unusual spaces (e.g. NBSP,
 * which does not break lines), tabs, and long runs of whitespace, empty lines and blank characters (they could push
 * the rest of the command out of view).
 *
 * Used where the user makes a decision based on external text, e.g. a console permission request
 * for a command or a preview of pasted text. A regular space and newline (`\n`, `\r\n`) stay
 * (a newline is visible with `white-space: pre-wrap`), a lone `\r` is shown as `⟨U+000D⟩`.
 * Description: docs/ARCHITECTURE.md, section "Console".
 */
export function revealHidden(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n(?:[ \t]*\n){2,}/g, (run) => `\n⟨${countLabel(run.split('\n').length - 2, 'pusta linia', 'puste linie', 'pustych linii')}⟩\n`)
    .replace(/[ \t]{4,}/g, (run) => `⟨${countLabel(run.length, 'odstęp', 'odstępy', 'odstępów')}⟩`)
    .replace(/\t/g, '⟨TAB⟩')
    .replace(HIDDEN_RUN, (run: string, char: string) => {
      const code = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
      const count = [...run].length;
      return count > 1 ? `⟨${code} ×${count}⟩` : `⟨${code}⟩`;
    });
}

/**
 * A run of the same hidden character (shown as a single marker with a count, e.g. `⟨U+2800 ×2000⟩`, so a long run
 * does not push the rest of the text out of view). Hidden are: control characters (except `\n`), format characters (text direction,
 * zero width, soft hyphen, tags), line and paragraph separators, spaces other than the regular one, unassigned
 * code points and "blank" characters that look like a space or are invisible: Hangul fillers (U+115F, U+1160,
 * U+3164, U+FFA0), the Braille blank (U+2800), variation selectors (U+FE00–U+FE0F, U+E0100–U+E01EF), U+034F,
 * U+17B4/5 and U+180B–U+180F. Tabs are replaced with `⟨TAB⟩` beforehand.
 */
const HIDDEN_RUN =
  /(?![\n ])([\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Cn}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}])\1*/gu;

/** The maximum number of lines and characters per line that `previewText` shows in full. */
const PREVIEW_LINES = 20;
const PREVIEW_LINE_CHARS = 300;

/**
 * Text preview for a confirmation question (e.g. pasting into the terminal): after `revealHidden`, and when the text is long,
 * the beginning and the end with a clear note of how much was omitted. It never truncates silently: the user knows they are not seeing something.
 */
export function previewText(text: string): string {
  const lines = revealHidden(text).split('\n').map(shortenLine);
  if (lines.length <= PREVIEW_LINES) {
    return lines.join('\n');
  }
  const head = lines.slice(0, PREVIEW_LINES - 5);
  const tail = lines.slice(-4);
  const skipped = lines.length - head.length - tail.length;
  return [...head, `⟨pominięto ${countLabel(skipped, 'linię', 'linie', 'linii')}⟩`, ...tail].join('\n');
}

function shortenLine(line: string): string {
  if (line.length <= PREVIEW_LINE_CHARS) {
    return line;
  }
  const skipped = line.length - 150 - 100;
  return `${line.slice(0, 150)}⟨pominięto ${countLabel(skipped, 'znak', 'znaki', 'znaków')}⟩${line.slice(-100)}`;
}
