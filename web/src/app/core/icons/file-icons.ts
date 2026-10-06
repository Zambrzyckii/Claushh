import { FILE_EXTENSIONS, FILE_NAMES, FOLDER_NAMES } from './file-icon-map';

/**
 * File and folder icons (docs/ARCHITECTURE.md, "Frontend"): a selection of Material Icon Theme, shipped in
 * public/file-icons/ and named by the generated file-icon-map.ts. A file is looked up by its whole name, then by every
 * suffix after a dot from the longest ("a.spec.ts": "spec.ts", then "ts"), then gets the default; a folder by its name,
 * with "-open" when it is expanded. Shown as <img>, so no SVG markup ever reaches the DOM.
 */
const BASE = 'file-icons/';

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();
  let icon = own(FILE_NAMES, lower);
  for (let dot = lower.indexOf('.'); icon === undefined && dot !== -1; dot = lower.indexOf('.', dot + 1)) {
    icon = own(FILE_EXTENSIONS, lower.slice(dot + 1));
  }
  return `${BASE}${icon ?? 'file'}.svg`;
}

export function folderIconUrl(name: string, open: boolean): string {
  return `${BASE}${own(FOLDER_NAMES, name.toLowerCase()) ?? 'folder'}${open ? '-open' : ''}.svg`;
}

/** Own keys only: a file named "constructor" must not find Object.prototype's. */
function own(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
