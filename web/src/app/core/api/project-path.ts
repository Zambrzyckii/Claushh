/**
 * File paths in the API are always RELATIVE to the projects directory on the server (e.g. `studia/lab/src/main.c`),
 * with `/` slashes. An empty string means the projects directory itself.
 *
 * This check is only an extra layer on the browser side. The real protection
 * (the expanded path must lie in the projects directory, also after resolving symlinks) is done by the backend.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path === '') {
    return true;
  }
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Last path segment, e.g. `main.c` for `src/main.c`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The workspace a path starts with, its first segment ('' for ''). */
export function workspaceOf(path: string): string {
  return path.split('/', 1)[0];
}

/** The repository a path lies in (`workspace/repo`), or null for a path less than three segments deep. */
export function repoOf(path: string): string | null {
  const parts = path.split('/');
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
}

/** A file's directory inside its repository, the segments between `workspace/repo` and the name. */
export function directoryInRepo(path: string): string {
  return path.split('/').slice(2, -1).join('/');
}
