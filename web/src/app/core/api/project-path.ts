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

/** Joins a directory and an entry name into a relative path. */
export function joinPath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}
