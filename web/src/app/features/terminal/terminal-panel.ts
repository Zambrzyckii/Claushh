import { Component, inject } from '@angular/core';

import { Dialogs } from '../../core/browser/dialogs';
import { TerminalInfo } from '../../core/realtime/terminal-protocol';
import { TerminalStore } from './terminal-store';
import { TerminalView } from './terminal-view';

/**
 * The "Terminal" tab in the bottom panel: a bar with terminals (each is a tmux session on the server) and the view
 * of the active one. All terminals are rendered, but only the active one is visible, so switching does not lose state.
 * State and communication: TerminalStore.
 */
@Component({
  selector: 'app-terminal-panel',
  imports: [TerminalView],
  templateUrl: './terminal-panel.html',
  styleUrl: './terminal-panel.scss'
})
export class TerminalPanel {
  protected readonly store = inject(TerminalStore);
  private readonly dialogs = inject(Dialogs);

  constructor() {
    void this.store.init();
  }

  protected close(terminal: TerminalInfo): void {
    if (!terminal.exited && !this.dialogs.confirm(`Close the terminal “${terminal.title}” and end the processes running in it?`)) {
      return;
    }
    void this.store.close(terminal.id);
  }

  protected retry(): void {
    void this.store.init();
  }
}
