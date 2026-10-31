// Frontend route of the e2e mock, which serves the built frontend from dist/web/browser with its types, and
// index.html with the page's CSP. It answers every request no other route took. server.mjs lists the route order.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/web/browser');

// CSP is the policy from <meta> in index.html plus `frame-ancestors`, which cannot be set in <meta>.
function pageCsp() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  if (!meta) throw new Error('index.html has no CSP policy');
  return `${meta[1]}; frame-ancestors 'none'`;
}

export async function frontendRoutes(req, res, url, session) {
  // frontend (SPA)
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };
  const headers = { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' };
  if (file.endsWith('index.html')) {
    headers['Cache-Control'] = 'no-store';
    headers['Content-Security-Policy'] = pageCsp();
    headers['X-Frame-Options'] = 'DENY';
  }
  res.writeHead(200, headers).end(fs.readFileSync(file));
  return true;
}
