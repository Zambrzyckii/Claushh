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
 * Clone URL: only `https://`, no login and password in the URL
 * (a token would end up in `.git/config`). Returns an error message or `null`.
 */
export function validateCloneUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return 'Podaj adres repozytorium.';
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Nieprawidłowy adres.';
  }
  if (parsed.protocol !== 'https:') {
    return 'Dozwolone są tylko adresy https://.';
  }
  if (parsed.username || parsed.password) {
    return 'Adres nie może zawierać loginu ani hasła.';
  }
  if (!parsed.hostname || parsed.pathname.replace(/\/+$/, '') === '') {
    return 'Adres musi wskazywać repozytorium, np. https://github.com/uzytkownik/projekt.git.';
  }
  return null;
}
