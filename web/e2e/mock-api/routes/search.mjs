// Search route of the e2e mock, with the search in files and its helpers, which answer as the backend does (the
// same checks, flags, limits, previews and order). server.mjs lists the route order.

import { isApiPath, json, readBody, xsrfOk } from '../http.mjs';
import { directoryExists, state } from '../state.mjs';

/**
 * Search in files (docs/ARCHITECTURE.md, "Search API contract") over state.files, as the backend answers it: the same
 * checks, flags, limits, previews and order; a binary file (null) is skipped. JavaScript's RegExp stands in for .NET's,
 * and what .NET refuses without backtracking (lookarounds, backreferences, atomic groups, conditionals, \G) is 400.
 */
const SEARCH_MAX_TEXT = 1000;
const SEARCH_MAX_MATCHES = 2000;
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;

function search(body) {
  const text = (value) => value === undefined || value === null || (typeof value === 'string' && value.length <= SEARCH_MAX_TEXT);
  const flag = (value) => value === undefined || value === null || typeof value === 'boolean';
  if (typeof body?.query !== 'string' || body.query.length < 1 || !text(body.query) || typeof body.path !== 'string'
    || !text(body.include) || !text(body.exclude) || !flag(body.matchCase) || !flag(body.wholeWord) || !flag(body.regex)) {
    return [400];
  }
  const pattern = searchPattern(body.query, body);
  const include = globs(body.include);
  const exclude = globs(body.exclude);
  if (!pattern || include === false || exclude === false || (body.path !== '' && !isApiPath(body.path))) return [400];
  if (!directoryExists(body.path)) return [404];
  const prefix = body.path === '' ? '' : body.path + '/';
  const paths = [...state.files.keys()].filter((p) => p.startsWith(prefix) && state.files.get(p) !== null).sort(bySegments);
  const files = [];
  let matchCount = 0;
  let limit = null;
  for (const p of paths) {
    const relative = p.slice(prefix.length);
    const content = state.files.get(p);
    if (relative.split('/').includes('node_modules') || (include && !include(relative)) || (exclude && exclude(relative))) continue;
    if (Buffer.byteLength(content, 'utf8') > SEARCH_MAX_FILE_BYTES || content.includes('\u0000')) continue;
    const matches = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && !limit; i++) {
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      const found = [];
      pattern.lastIndex = 0;
      for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
        if (m[0].length === 0) {
          pattern.lastIndex++;
          continue;
        }
        if (matchCount === SEARCH_MAX_MATCHES) {
          limit = 'results';
          break;
        }
        found.push([m.index, m[0].length]);
        matchCount++;
      }
      if (found.length) matches.push(previewOf(line, i + 1, found));
    }
    if (matches.length) files.push({ path: p, matches });
    if (limit) break;
  }
  return [200, { files, matchCount, limit }];
}

function searchPattern(query, { matchCase, wholeWord, regex }) {
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  if (regex && /\(\?<?[=!]|\(\?>|\(\?\(|\\[1-9]|\\k<|\\G/.test(source)) return null;
  try {
    new RegExp(source, 'u');
    if (wholeWord) source = `\\b(?:${source})\\b`;
    return new RegExp(source, matchCase ? 'gu' : 'giu');
  } catch {
    return null;
  }
}

/** From at most 30 characters before the first match, without leading whitespace or half a character, at most 250. */
function previewOf(line, number, found) {
  const first = found[0][0];
  let cut = Math.max(0, first - 30);
  while (cut < first && /\s/.test(line[cut])) cut++;
  if (cut < first && /[\uDC00-\uDFFF]/.test(line[cut])) cut++;
  let length = Math.min(250, line.length - cut);
  if (length > 0 && cut + length < line.length && /[\uD800-\uDBFF]/.test(line[cut + length - 1])) length--;
  const ranges = found.map(([index, size]) => [Math.max(0, index - cut), Math.min(length, index + size - cut)]).filter(([s, e]) => s < e);
  return { line: number, column: first + 1, preview: line.slice(cut, cut + length), ranges };
}

/** Comma-separated globs as the backend reads them; null without one, false for ".." after the start. */
function globs(text) {
  const tests = [];
  for (const part of (text ?? '').split(',')) {
    let glob = part.trim().replace(/^\/+|\/+$/g, '');
    if (glob.startsWith('./')) glob = glob.slice(2);
    if (!glob) continue;
    const base = glob.includes('/') ? glob : `**/${glob}`;
    if (base.split('/').slice(1).includes('..')) return false;
    tests.push(globRegExp(base), globRegExp(`${base}/**/*`));
  }
  return tests.length ? (relative) => tests.some((re) => re.test(relative)) : null;
}

/** `*` within a name, `**` any depth; every other character literal, as in Microsoft.Extensions.FileSystemGlobbing. */
function globRegExp(glob) {
  const parts = glob.split('/');
  const source = parts
    .map((part, i) => {
      if (part === '**') return i === parts.length - 1 ? '.*' : '(?:[^/]+/)*';
      return part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + (i === parts.length - 1 ? '' : '/');
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** The backend's walk order: by name at each level, ordinal (UTF-16 units). */
function bySegments(a, b) {
  const [x, y] = [a.split('/'), b.split('/')];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

export async function searchRoutes(req, res, url, session) {
  // search in files
  if (url.pathname === '/api/search' && req.method === 'POST') {
    if (!session) {
      json(res, 401);
      return true;
    }
    const ok = xsrfOk(req);
    const body = await readBody(req);
    state.log.push({ path: 'search', xsrf: ok });
    if (!ok) {
      json(res, 400);
      return true;
    }
    const [status, result] = search(body);
    json(res, status, result);
    return true;
  }

  return false;
}
