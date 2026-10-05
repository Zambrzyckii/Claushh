/**
 * Browser-side validation of the Workspace panel forms. It is only a convenience and an extra layer:
 * the backend checks the same (docs/ARCHITECTURE.md, section "Workspaces and git").
 */

const WORKSPACE_NAME = /^[\p{L}\p{N} _-]{1,40}$/u;

/** Workspace name: letters, digits, spaces, `-` and `_`, up to 40 characters. Returns an error message or `null`. */
export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Enter a name.';
  }
  if (!WORKSPACE_NAME.test(trimmed)) {
    return 'A name has up to 40 characters: letters, digits, spaces, - and _.';
  }
  return null;
}

/**
 * Clone URL in strict form: `https://host[:port]/path`, host and path only from Latin letters,
 * digits and `.` `_` `~` `-`. No login and password (a token would end up in `.git/config`), no `@`, `\`, `%`, `?`, `#`
 * and spaces, because different parsers (browser, .NET, git, curl) read them differently: e.g. in
 * `https://github.com\@evil.com/r` the browser sees the host `github.com`, and git sees `evil.com`.
 */
const CLONE_URL = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)+\/?$/;

/**
 * Clone URL: only `https://` in strict form (`CLONE_URL`) and in canonical form (e.g. no `..`
 * in the path and no uppercase letters in the host name), so what we checked is exactly what git gets.
 * Returns an error message or `null`. The backend checks the same (docs/ARCHITECTURE.md, "Workspaces and git").
 */
export function validateCloneUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return 'Enter the repository URL.';
  }
  if (!/^https:\/\//i.test(trimmed)) {
    return 'Only https:// URLs are allowed.';
  }
  if (trimmed.slice('https://'.length).split('/', 1)[0].includes('@')) {
    return 'The URL must not contain a user name or password.';
  }
  if (!CLONE_URL.test(trimmed)) {
    return 'The URL may contain only Latin letters, digits and . _ ~ - /, e.g. https://github.com/user/project.git.';
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Invalid URL.';
  }
  if (parsed.href !== trimmed || parsed.username || parsed.password) {
    return 'Invalid URL. Copy it unchanged, e.g. from the “Code” button on GitHub.';
  }
  if (!CLONE_DIRECTORY.test(cloneDirectoryName(trimmed))) {
    return 'The URL gives an invalid directory name (it must start with a letter, a digit or _).';
  }
  return null;
}

/**
 * Repository directory name: the last segment of the URL without `.git`. Starts with a letter, digit or `_`,
 * so it cannot be `.`, `..`, `.git` or start with `-` (cloning outside the workspace or into its `.git`).
 */
const CLONE_DIRECTORY = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** Last segment of the URL path without the trailing `/` and `.git`, e.g. `project` from `https://github.com/u/project.git`. */
export function cloneDirectoryName(url: string): string {
  return url.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/, '');
}
