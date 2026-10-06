import { Component, computed, inject, input } from '@angular/core';

import { SessionTimer } from '../../core/auth/session-timer';
import { DeviceLayout } from '../../core/browser/device-layout';
import { RepoStatusStore } from '../../core/project/repo-status';
import { countLabel } from '../../core/text/format';
import { ConsoleStore } from '../console/console-store';
import { EditorStore } from '../editor/editor-store';

/**
 * The status bar of both layouts (docs/ARCHITECTURE.md, "Frontend" → "Layout"), read-only: VS Code's items without their
 * pickers. Left: the branch, the changes, the console's state and the unsaved files. Right: the cursor and the language
 * (on a phone only in the Editor tab), and on a desktop the session countdown with "Extend"; the phone keeps its
 * countdown in the top bar.
 */
@Component({
  selector: 'app-status-bar',
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.scss'
})
export class StatusBar {
  protected readonly layout = inject(DeviceLayout);
  protected readonly editor = inject(EditorStore);
  protected readonly repoStatus = inject(RepoStatusStore);
  protected readonly sessionTimer = inject(SessionTimer);
  private readonly console = inject(ConsoleStore);

  /** False on a phone's Terminal and Console tabs: the cursor and the language belong to the editor. */
  readonly editorShown = input(true);

  protected readonly changesLabel = computed(() => {
    const count = this.repoStatus.changeCount();
    return count === 0 ? 'no changes' : countLabel(count, 'change', 'changes');
  });

  protected readonly consoleStatus = computed(() => {
    if (this.console.connectionState() !== 'connected') {
      return 'Console: disconnected';
    }
    switch (this.console.state()) {
      case 'working':
        return 'Console: working';
      case 'waiting':
        return 'Console: waiting for permission';
      case 'error':
        return 'Console: error';
      default:
        return 'Console: idle';
    }
  });
}
