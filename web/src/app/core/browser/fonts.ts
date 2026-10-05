/**
 * The self-hosted monospace font for Monaco and xterm (docs/ARCHITECTURE.md, "Frontend"): both measure their character
 * cells when they are created, so they wait for JetBrains Mono first (3 s at most), and measure again when a font
 * arrives later.
 */
const MONO_FACES = ['13px "JetBrains Mono"', 'bold 13px "JetBrains Mono"', 'italic 13px "JetBrains Mono"'];
const FONT_WAIT_MS = 3000;

let ready: Promise<void> | null = null;

function fontSet(): FontFaceSet | undefined {
  return (document as Document & { fonts?: FontFaceSet }).fonts;
}

/** Resolves once JetBrains Mono (regular, bold, italic) is loaded, after 3 s at most; never rejects. */
export function monoFontReady(): Promise<void> {
  const fonts = fontSet();
  if (!fonts) {
    return Promise.resolve();
  }
  ready ??= Promise.race([
    Promise.all(MONO_FACES.map((face) => fonts.load(face))).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, FONT_WAIT_MS))
  ]).catch(() => undefined);
  return ready;
}

/** Calls `callback` whenever the browser has finished loading fonts; returns the function that stops it. */
export function onFontsLoaded(callback: () => void): () => void {
  const fonts = fontSet();
  if (!fonts) {
    return () => undefined;
  }
  const listener = () => callback();
  fonts.addEventListener('loadingdone', listener);
  return () => fonts.removeEventListener('loadingdone', listener);
}
