// Mock backend for e2e tests: serves the built frontend (dist/web/browser) and implements the contracts
// from docs/ARCHITECTURE.md (authentication, files, search, the terminal theme, workspaces and git, the console hub in the SignalR JSON protocol
// over WebSocket, the terminal hub with a simple simulated shell). Instead of the real Claude Code it replays short
// scripts that depend on the prompt text.
// Git is simulated: the "committed" file content is their state at reset, and status is the difference from it.
//
// For tests only. The /__test/* endpoints let tests reset and inspect the state, so the server listens
// only on 127.0.0.1. Started by Playwright (playwright.config.ts → webServer).

import http from 'node:http';

import { HOST, ORIGIN, PORT, SECURITY_HEADERS, json, sessionOf } from './http.mjs';
import { consoleHub } from './hubs/console.mjs';
import { attachHubs } from './hubs/signalr.mjs';
import { terminalHub } from './hubs/terminal.mjs';
import { authRoutes } from './routes/auth.mjs';
import { fileRoutes } from './routes/files.mjs';
import { frontendRoutes } from './routes/frontend.mjs';
import { passkeyRoutes } from './routes/passkeys.mjs';
import { searchRoutes } from './routes/search.mjs';
import { terminalThemeRoutes } from './routes/terminal-theme.mjs';
import { testControlRoutes } from './routes/test-control.mjs';
import { workspaceRoutes } from './routes/workspaces.mjs';

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    await handle(req, res);
  } catch (error) {
    // A bad request (e.g. bad JSON, bad URL) must not bring down the test server.
    if (!res.headersSent) json(res, 400, { message: String(error?.message ?? error) });
    else res.end();
  }
});

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const session = sessionOf(req);

  // Each request goes to the first route module with a matching branch. The order matters in two places. The passkey
  // login comes before the generic passkey routes inside routes/passkeys.mjs, and the files routes, which take every
  // other /api/ path, come last before the frontend, which answers every request left. The auth routes may come
  // before the passkey routes because their paths are disjoint.
  for (const routes of [testControlRoutes, authRoutes, passkeyRoutes, workspaceRoutes, searchRoutes, terminalThemeRoutes, fileRoutes, frontendRoutes]) {
    if (await routes(req, res, url, session)) return;
  }
}

// ---------- SignalR hubs (JSON protocol): console and terminal ----------

attachHubs(server, { '/hubs/console': consoleHub, '/hubs/terminal': terminalHub });

server.listen(PORT, HOST, () => console.log(`mock api on ${ORIGIN}`));
