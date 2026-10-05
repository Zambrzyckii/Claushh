/**
 * The color tokens of web/src/styles.scss read at run time, so the Monaco and xterm themes follow the same palette
 * (docs/ARCHITECTURE.md, "Frontend"). Tokens are written as hex in styles.scss.
 */
export function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
