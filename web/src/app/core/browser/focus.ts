/**
 * Whether the user is currently typing somewhere other than `own`: in a text field, in the Monaco editor or in the terminal.
 *
 * Views that set focus by themselves after asynchronous loading (the terminal after connecting, the editor after opening a file)
 * check this first. Otherwise focus would jump while typing and the rest of the text (including Enter)
 * would end up, e.g., from the console field in the shell.
 */
export function isTypingElsewhere(own: Element): boolean {
  const active = own.ownerDocument.activeElement;
  if (!active || active === own.ownerDocument.body || own.contains(active)) {
    return false;
  }
  return active.closest(TYPING_SURFACES) !== null;
}

const TYPING_SURFACES = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor, .xterm';
