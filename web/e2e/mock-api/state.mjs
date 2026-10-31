// Shared state of the e2e mock, with the seed data, the state every route and hub reads and `reset` replaces, the
// "committed" content that simulated git compares with, and the directory queries several areas use. The route order
// is listed in server.mjs.

import fs from 'node:fs';

const seed = JSON.parse(fs.readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
export const { USER, MAIN, BAZY_SQL } = seed;

const INITIAL_FILES = {
  [MAIN]: '#include <stdio.h>\n\nint main(void)\n{\n    return 0;\n}\n',
  'studia/lab-3-sieci/src/parser.c': 'int parse(void)\n{\n    return 1;\n}\n',
  'studia/lab-3-sieci/Makefile': 'all:\n\tcc -o app src/main.c\n',
  'studia/lab-3-sieci/logo.png': null,
  'studia/so-projekt-shell/src/shell.c': 'int main(void) { return 0; }\n',
  'studia/bazy-danych-lab/zadanie4.sql': '-- zadanie 4\nCREATE VIEW v AS SELECT 1;\n',
  'prywatne/notatki/README.md': '# Notatki\n'
};

const INITIAL_WORKSPACES = [
  ['studia', 'Studia'],
  ['prywatne', 'Prywatne']
];

export const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function initialRepos() {
  return new Map([
    ['studia/lab-3-sieci', { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, lastCommit: { message: 'parser: szkielet parse_ipv4', date: minutesAgo(12) } }],
    ['studia/so-projekt-shell', { branch: 'dev', upstream: 'origin/dev', ahead: 0, behind: 0, lastCommit: { message: 'obsługa potoków', date: minutesAgo(2 * 1440) } }],
    ['studia/bazy-danych-lab', {
      branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2,
      lastCommit: { message: 'zadanie 4: widoki', date: minutesAgo(7 * 1440) },
      remote: { message: 'poprawki od prowadzącego', files: { [BAZY_SQL]: '-- zadanie 4 (poprawione)\nCREATE VIEW v AS SELECT 2;\n' } }
    }],
    ['prywatne/notatki', { branch: 'main', upstream: null, ahead: 0, behind: 0, lastCommit: { message: 'semestr 5', date: minutesAgo(3 * 1440) } }]
  ]);
}

export let state;
export function reset() {
  for (const socket of [...(state?.sockets ?? []), ...(state?.terminalSockets ?? [])]) socket.terminate();
  state = {
    sessions: new Map(), // sid (secret from the cookie) -> { id (public), userName, ip, device, createdAt, lastActivityAt, expiresAt, absoluteExpiresAt }
    idleSeconds: 30 * 60,
    absoluteSeconds: 12 * 3600,
    logins: [],
    loginFailures: 0,
    passkeys: [], // { id, name, createdAt, synced }, in the order added
    registrations: new Map(), // sid -> challenge of the session's creation options
    freshUntil: new Map(), // sid -> time (ms) until which the session may add and remove passkeys
    challenges: new Map(), // login challenge id (the passkey cookie) -> challenge
    xsrfTokens: new Map(), // token -> public id of the session it was issued for (null: no session)
    files: new Map(Object.entries(INITIAL_FILES)),
    workspaces: new Map(INITIAL_WORKSPACES),
    repos: initialRepos(),
    log: [],
    sockets: new Set(),
    terminalSockets: new Set(),
    terminals: new Map(), // id -> { id, title, cwd, exited, seq, history, line, inputs, sizes, inputSeq }
    terminalCounter: 0,
    conversations: new Map(), // id -> { projectPath, events, running }
    latestByProject: new Map(),
    prompts: [],
    terminalThemeFile: null, // the text of the pywal file GET /api/terminal/theme answers from (/__test/terminal-theme)
    // failures on demand from tests (/__test/fault)
    faults: { dropInputAck: 0, attachDelayMs: 0, hubDownMs: 0, downAfterDropMs: 0, listDelayMs: 0 },
    hubDownUntil: 0
  };
}
reset();

/** "Committed" state = repository file content at reset time (or after pull/clone). */
export function snapshotCommitted() {
  for (const [repoPath, repo] of state.repos) {
    repo.committed = new Map([...state.files].filter(([p]) => p.startsWith(repoPath + '/')));
  }
}
snapshotCommitted();

export function listDir(dir) {
  const out = new Map();
  const add = (p, isDirectory) => {
    if (dir && !p.startsWith(dir + '/')) return;
    const rest = dir ? p.slice(dir.length + 1) : p;
    const [name, ...more] = rest.split('/');
    out.set(name, { name, path: dir ? `${dir}/${name}` : name, kind: more.length || isDirectory ? 'directory' : 'file' });
  };
  for (const p of state.files.keys()) add(p, false);
  for (const p of [...state.workspaces.keys(), ...state.repos.keys()]) add(p, true);
  return [...out.values()];
}

/** Whether `dir` is a directory of the mock: the projects directory, a workspace or repository, or a parent of a file. */
export function directoryExists(dir) {
  if (dir === '' || state.workspaces.has(dir) || state.repos.has(dir)) return true;
  return [...state.files.keys(), ...state.workspaces.keys(), ...state.repos.keys()].some((p) => p.startsWith(dir + '/'));
}
