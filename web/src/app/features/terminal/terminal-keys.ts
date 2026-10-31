import { Component, input, output } from '@angular/core';

/**
 * The row of terminal keys on a phone (docs/ARCHITECTURE.md, section "Terminal", "Rules"), Esc, Tab, a sticky Ctrl, the
 * arrows and Paste. It only shows them and reports a press. TerminalView acts on the press, so Esc, Tab and the arrows
 * type through `term.input` into the same queue as typed text.
 */
@Component({
  selector: 'app-terminal-keys',
  templateUrl: './terminal-keys.html',
  styleUrl: './terminal-keys.scss'
})
export class TerminalKeys {
  readonly ctrl = input.required<boolean>();
  readonly disabled = input(false);
  readonly pressed = output<PhoneKey>();

  /** The phone keys, in the row's order. */
  protected readonly keys: readonly { id: PhoneKey; label: string; icon?: string }[] = [
    { id: 'esc', label: 'Esc' },
    { id: 'tab', label: 'Tab' },
    { id: 'ctrl', label: 'Ctrl' },
    { id: 'left', label: 'Left', icon: 'arrow-left' },
    { id: 'up', label: 'Up', icon: 'arrow-up' },
    { id: 'down', label: 'Down', icon: 'arrow-down' },
    { id: 'right', label: 'Right', icon: 'arrow-right' },
    { id: 'paste', label: 'Paste', icon: 'clippy' }
  ];
}

export type PhoneKey = 'esc' | 'tab' | 'ctrl' | 'left' | 'up' | 'down' | 'right' | 'paste';

const ARROWS = { left: 'D', up: 'A', down: 'B', right: 'C' } as const;

/** Esc, Tab and the arrows as a terminal sends them; arrows follow the application cursor mode. */
export function keySequence(key: 'esc' | 'tab' | keyof typeof ARROWS, applicationCursor: boolean): string {
  if (key === 'esc') {
    return '\x1b';
  }
  if (key === 'tab') {
    return '\t';
  }
  return (applicationCursor ? '\x1bO' : '\x1b[') + ARROWS[key];
}
