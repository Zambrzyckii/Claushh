// Terminal theme route of the e2e mock, with the check of the pywal colors.json a test set, as the backend checks
// the file. server.mjs lists the route order.

import { json } from '../http.mjs';
import { state } from '../state.mjs';

/**
 * The terminal theme (docs/ARCHITECTURE.md, "Terminal theme API contract") from the text of a pywal colors.json a test
 * set (/__test/terminal-theme), checked as the backend checks the file: at most 16 KiB, a JSON object, the 19 values
 * "#" and 6 hex digits, sent in lower case and nothing else. null: 204.
 */
const THEME_MAX_BYTES = 16 * 1024;

function terminalTheme(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > THEME_MAX_BYTES) return null;
  let file;
  try {
    file = JSON.parse(content);
  } catch {
    return null;
  }
  const section = (name) => {
    const value = file?.[name];
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  };
  const special = section('special');
  const colors = section('colors');
  if (!special || !colors) return null;
  const values = [special.background, special.foreground, special.cursor, ...Array.from({ length: 16 }, (_, i) => colors[`color${i}`])];
  if (!values.every((value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value))) return null;
  const [background, foreground, cursor, ...palette] = values.map((value) => value.toLowerCase());
  return { background, foreground, cursor, palette };
}

export async function terminalThemeRoutes(req, res, url, session) {
  // the terminal's colours (a GET: no XSRF token, as in the backend)
  if (url.pathname === '/api/terminal/theme' && req.method === 'GET') {
    if (!session) {
      json(res, 401);
      return true;
    }
    const theme = terminalTheme(state.terminalThemeFile);
    theme ? json(res, 200, theme) : json(res, 204);
    return true;
  }

  return false;
}
