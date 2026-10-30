import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

/**
 * The terminal's colours from the server (`GET /api/terminal/theme`; contract: docs/ARCHITECTURE.md, "Terminal" →
 * "Terminal theme API contract"): pywal's palette, when the server has one. Asked for by every terminal view when it is
 * created and never cached, so a new terminal gets the colours of the moment.
 */

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  /** The 16 ANSI colours, 0 to 15. */
  palette: string[];
}

/** No terminal waits longer for its colours than for its font (`monoFontReady`, 3 s). */
const THEME_TIMEOUT_MS = 3_000;
const COLOUR = /^#[0-9a-f]{6}$/;

@Injectable({ providedIn: 'root' })
export class TerminalThemeApi {
  private readonly http = inject(HttpClient);

  /** Never rejects: a 204, an error, a malformed body or no answer within 3 s give null (the portal's colours). */
  async load(): Promise<TerminalTheme | null> {
    try {
      return themeOf(await firstValueFrom(this.http.get<unknown>('/api/terminal/theme').pipe(timeout(THEME_TIMEOUT_MS))));
    } catch {
      return null;
    }
  }
}

/** The body when it is the contract's theme: 19 colours, "#" and 6 lower-case hex digits, 16 of them in the palette. */
function themeOf(body: unknown): TerminalTheme | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { background, foreground, cursor, palette } = body as Partial<Record<keyof TerminalTheme, unknown>>;
  const colours: unknown[] = [background, foreground, cursor, ...(Array.isArray(palette) && palette.length === 16 ? palette : [null])];
  if (!colours.every((colour): colour is string => typeof colour === 'string' && COLOUR.test(colour))) {
    return null;
  }
  return { background: colours[0], foreground: colours[1], cursor: colours[2], palette: colours.slice(3) };
}
