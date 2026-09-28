/**
 * Browser-side validation of the Workspace panel forms. It is only a convenience and an extra layer:
 * the backend checks the same (docs/ARCHITECTURE.md, section "Workspaces and git").
 */

const WORKSPACE_NAME = /^[\p{L}\p{N} _-]{1,40}$/u;

/** Workspace name: letters, digits, spaces, `-` and `_`, up to 40 characters. Returns an error message or `null`. */
export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Podaj nazwę.';
  }
  if (!WORKSPACE_NAME.test(trimmed)) {
    return 'Nazwa może mieć do 40 znaków: litery, cyfry, spacje, - i _.';
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
    return 'Podaj adres repozytorium.';
  }
  if (!/^https:\/\//i.test(trimmed)) {
    return 'Dozwolone są tylko adresy https://.';
  }
  if (trimmed.slice('https://'.length).split('/', 1)[0].includes('@')) {
    return 'Adres nie może zawierać loginu ani hasła.';
  }
  if (!CLONE_URL.test(trimmed)) {
    return 'Adres może zawierać tylko litery łacińskie, cyfry i znaki . _ ~ - /, np. https://github.com/uzytkownik/projekt.git.';
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Nieprawidłowy adres.';
  }
  if (parsed.href !== trimmed || parsed.username || parsed.password) {
    return 'Nieprawidłowy adres. Skopiuj go bez zmian, np. z przycisku „Code” na GitHubie.';
  }
  if (!CLONE_DIRECTORY.test(cloneDirectoryName(trimmed))) {
    return 'Z adresu wychodzi nieprawidłowa nazwa katalogu (musi zaczynać się literą, cyfrą albo _).';
  }
  return null;
}

/**
 * Repository directory name: the last segment of the URL without `.git`. Starts with a letter, digit or `_`,
 * so it cannot be `.`, `..`, `.git` or start with `-` (cloning outside the workspace or into its `.git`).
 */
const CLONE_DIRECTORY = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** Last segment of the URL path without the trailing `/` and `.git`, e.g. `projekt` from `https://github.com/u/projekt.git`. */
export function cloneDirectoryName(url: string): string {
  return url.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/, '');
}
