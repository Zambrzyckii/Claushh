// Files routes of the e2e mock, with every /api/ path no other route took (list, read and save), the file versions
// and the save limit. server.mjs lists the route order, and these routes come last before the frontend.

import crypto from 'node:crypto';

import { json, readBody, xsrfOk } from '../http.mjs';
import { directoryExists, listDir, state } from '../state.mjs';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // the largest file the files API saves (docs/ARCHITECTURE.md, "Files API contract")
const ABSENT_VERSION = 'absent'; // the version of a file that does not exist: a save with it creates the file

// A shortened SHA-1: the contract fixes only the version of a missing file (ABSENT_VERSION), the rest is opaque.
const version = (content) => crypto.createHash('sha1').update(content ?? '').digest('hex').slice(0, 12);

export async function fileRoutes(req, res, url, session) {
  // files
  if (url.pathname.startsWith('/api/')) {
    if (!session) {
      json(res, 401);
      return true;
    }
    const p = url.searchParams.get('path') ?? '';
    if (p.startsWith('/') || p.split('/').includes('..')) {
      json(res, 400);
      return true;
    }
    if (url.pathname === '/api/files/list') {
      state.log.push({ path: 'list', p });
      json(res, 200, listDir(p));
      return true;
    }
    if (url.pathname === '/api/files/content' && req.method === 'GET') {
      if (!state.files.has(p)) {
        json(res, 404);
        return true;
      }
      if (state.files.get(p) === null) {
        json(res, 415);
        return true;
      }
      json(res, 200, { path: p, content: state.files.get(p), version: version(state.files.get(p)) });
      return true;
    }
    if (url.pathname === '/api/files/content' && req.method === 'PUT') {
      const ok = xsrfOk(req);
      const body = await readBody(req);
      state.log.push({ path: 'write', p, xsrf: ok });
      if (!ok) {
        json(res, 400);
        return true;
      }
      if (typeof body?.content !== 'string' || typeof body?.baseVersion !== 'string') {
        json(res, 400);
        return true;
      }
      // As in the backend: a file can only be saved in a directory that exists (a file is no directory), before any
      // content or version check.
      if (!directoryExists(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')) {
        json(res, 404);
        return true;
      }
      // As in the backend, whatever the version: text that a read would refuse, and more than 5 MB, is not saved.
      if (body.content.includes('\u0000')) {
        json(res, 415);
        return true;
      }
      if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) {
        json(res, 413);
        return true;
      }
      // Decided by the existence of the file, not by its content: a missing, an empty and a binary file hash alike.
      const current = state.files.has(p) ? version(state.files.get(p)) : ABSENT_VERSION;
      if (body.baseVersion !== current) {
        json(res, 409, { currentVersion: current });
        return true;
      }
      state.files.set(p, body.content);
      json(res, 200, { version: version(body.content) });
      return true;
    }
    json(res, 404);
    return true;
  }

  return false;
}
