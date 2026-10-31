// Workspace routes of the e2e mock, with the workspaces, their repositories, cloning and the simulated git (show,
// status, pull and push), and the helpers they use. server.mjs lists the route order.

import { isApiPath, json, readBody, sleep, xsrfOk } from '../http.mjs';
import { minutesAgo, state } from '../state.mjs';

function gitFiles(repoPath) {
  const repo = state.repos.get(repoPath);
  const files = [];
  for (const [p, content] of state.files) {
    if (!p.startsWith(repoPath + '/')) continue;
    if (!repo.committed.has(p)) files.push({ path: p, status: 'untracked' });
    else if (repo.committed.get(p) !== content) files.push({ path: p, status: 'modified' });
  }
  for (const p of repo.committed.keys()) {
    if (!state.files.has(p)) files.push({ path: p, status: 'deleted' });
  }
  return files;
}

function repoSummary(repoPath) {
  const repo = state.repos.get(repoPath);
  return {
    name: repoPath.slice(repoPath.lastIndexOf('/') + 1),
    path: repoPath,
    branch: repo.branch,
    changes: gitFiles(repoPath).length,
    upstream: repo.upstream,
    ahead: repo.ahead,
    behind: repo.behind,
    lastCommit: repo.lastCommit
  };
}

/**
 * Clone URL: the same strict rule as in the frontend and in the backend contract
 * (docs/ARCHITECTURE.md, "Workspaces and git"). `null` when the URL is valid.
 */
function cloneUrlProblem(url) {
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)+\/?$/.test(url)) {
    return 'Invalid URL.';
  }
  try {
    const parsed = new URL(url);
    if (parsed.href !== url || parsed.username || parsed.password) return 'Invalid URL.';
  } catch {
    return 'Invalid URL.';
  }
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(cloneName(url)) ? null : 'Invalid directory name.';
}

/** Repository directory name: the last URL segment without `.git` (POST /api/repos/clone contract). */
const cloneName = (url) => url.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '');

const reposIn = (workspace) => [...state.repos.keys()].filter((p) => p.split('/')[0] === workspace);
const slug = (name) => name.trim().toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/** English plural of "commit" (docs/ARCHITECTURE.md, "Workspaces and git"): 1 commit, otherwise commits. */
const commitWord = (n) => (n === 1 ? 'commit' : 'commits');

/** Repositories by name, ordinal and ignoring case, compared upper-cased like the backend's OrdinalIgnoreCase. */
function byName(a, b) {
  const [x, y] = [a, b].map((p) => p.slice(p.lastIndexOf('/') + 1).toUpperCase());
  return x < y ? -1 : x > y ? 1 : 0;
}

export async function workspaceRoutes(req, res, url, session) {
  // workspaces and git
  if (['/api/workspaces', '/api/repos', '/api/repos/clone'].includes(url.pathname) || url.pathname.startsWith('/api/git/')) {
    if (!session) {
      json(res, 401);
      return true;
    }
    if (req.method !== 'GET' && !xsrfOk(req)) {
      json(res, 400, { message: 'Missing XSRF token.' });
      return true;
    }

    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      json(res, 200, [...state.workspaces].map(([p, name]) => ({ name, path: p, repoCount: reposIn(p).length })));
      return true;
    }
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      const { name } = (await readBody(req)) ?? {};
      state.log.push({ path: 'create-workspace', name });
      if (typeof name !== 'string' || !/^[\p{L}\p{N} _-]{1,40}$/u.test(name.trim()) || !slug(name)) {
        json(res, 400, { message: 'Invalid name.' });
        return true;
      }
      const p = slug(name);
      if (state.workspaces.has(p)) {
        json(res, 409, { message: 'Workspace already exists.' });
        return true;
      }
      state.workspaces.set(p, name.trim());
      json(res, 201, { name: name.trim(), path: p, repoCount: 0 });
      return true;
    }
    if (url.pathname === '/api/repos' && req.method === 'GET') {
      const ws = url.searchParams.get('workspace');
      if (!isApiPath(ws, 1)) {
        json(res, 400);
        return true;
      }
      if (!state.workspaces.has(ws)) {
        json(res, 404);
        return true;
      }
      json(res, 200, reposIn(ws).sort(byName).map(repoSummary));
      return true;
    }
    if (url.pathname === '/api/repos/clone' && req.method === 'POST') {
      const { workspace, url: remote } = (await readBody(req)) ?? {};
      state.log.push({ path: 'clone', workspace, url: remote });
      if (!isApiPath(workspace, 1)) {
        json(res, 400);
        return true;
      }
      if (!state.workspaces.has(workspace)) {
        json(res, 404);
        return true;
      }
      const problem = cloneUrlProblem(remote);
      if (problem) {
        json(res, 400, { message: problem });
        return true;
      }
      await sleep(300);
      const name = cloneName(remote);
      const repoPath = `${workspace}/${name}`;
      if (state.repos.has(repoPath)) {
        json(res, 409, { message: 'Directory already exists.' });
        return true;
      }
      if (remote.includes('nie-istnieje')) {
        json(res, 502, { message: `remote: Repository not found.\nfatal: repository '${remote}' not found` });
        return true;
      }
      state.files.set(`${repoPath}/README.md`, `# ${name}\n`);
      state.repos.set(repoPath, {
        branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0,
        lastCommit: { message: 'Initial commit', date: minutesAgo(60 * 24 * 30) },
        committed: new Map([[`${repoPath}/README.md`, `# ${name}\n`]])
      });
      json(res, 201, repoSummary(repoPath));
      return true;
    }

    const gitMethods = { '/api/git/show': 'GET', '/api/git/status': 'GET', '/api/git/pull': 'POST', '/api/git/push': 'POST' };
    if (gitMethods[url.pathname] !== req.method) {
      json(res, 404);
      return true;
    }
    const repoPath = url.searchParams.get('repo');
    const file = url.searchParams.get('path');
    const isShow = url.pathname === '/api/git/show';
    if (!isApiPath(repoPath, 2) || (isShow && !(isApiPath(file) && file.startsWith(repoPath + '/')))) {
      json(res, 400);
      return true;
    }
    const repo = state.repos.get(repoPath);
    if (!repo) {
      json(res, 404);
      return true;
    }
    if (isShow) {
      if (!repo.committed.has(file)) {
        json(res, 404);
        return true;
      }
      // A binary file (null in the mock) is 415, as in the files API.
      const content = repo.committed.get(file);
      content === null ? json(res, 415) : json(res, 200, { content });
      return true;
    }
    if (url.pathname === '/api/git/status' && req.method === 'GET') {
      json(res, 200, { branch: repo.branch, ahead: repo.ahead, behind: repo.behind, files: gitFiles(repoPath) });
      return true;
    }
    if (url.pathname === '/api/git/pull' && req.method === 'POST') {
      state.log.push({ path: 'pull', repo: repoPath });
      await sleep(150);
      if (!repo.upstream) {
        json(res, 400, { message: 'The branch has no upstream.' });
        return true;
      }
      if (repo.behind === 0 || !repo.remote) {
        json(res, 200, { message: 'Already up to date.', changedPaths: [] });
        return true;
      }
      // Diverged (ahead and behind both non-zero): not a fast-forward, as the backend's `git merge --ff-only` answers.
      if (repo.ahead > 0) {
        json(res, 409, { message: `fatal: Not possible to fast-forward, aborting.` });
        return true;
      }
      const incoming = Object.keys(repo.remote.files);
      const blocked = incoming.filter((p) => state.files.get(p) !== repo.committed.get(p));
      if (blocked.length) {
        json(res, 409, { message: `error: Your local changes to the following files would be overwritten by merge:\n\t${blocked.join('\n\t')}` });
        return true;
      }
      for (const [p, content] of Object.entries(repo.remote.files)) {
        state.files.set(p, content);
        repo.committed.set(p, content);
      }
      repo.lastCommit = { message: repo.remote.message, date: new Date().toISOString() };
      repo.remote = null;
      const pulled = repo.behind;
      repo.behind = 0;
      json(res, 200, { message: `Pulled ${pulled} ${commitWord(pulled)}.`, changedPaths: incoming });
      return true;
    }
    if (url.pathname === '/api/git/push' && req.method === 'POST') {
      state.log.push({ path: 'push', repo: repoPath });
      await sleep(150);
      if (!repo.upstream) {
        json(res, 400, { message: "No remote 'origin'." });
        return true;
      }
      // Nothing ahead: nothing to push, without the network, whatever "behind" is (the contract's rule).
      if (repo.ahead === 0) {
        json(res, 200, { message: 'Nothing to push.' });
        return true;
      }
      // Ahead and behind both non-zero: the remote has newer commits too, so the push is [rejected].
      if (repo.behind > 0) {
        json(res, 409, { message: ` ! [rejected]        ${repo.branch} -> ${repo.branch} (fetch first)` });
        return true;
      }
      const pushed = repo.ahead;
      repo.ahead = 0;
      json(res, 200, { message: `Pushed ${pushed} ${commitWord(pushed)} to ${repo.upstream}.` });
      return true;
    }
    json(res, 404);
    return true;
  }

  return false;
}
