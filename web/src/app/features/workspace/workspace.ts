import { Component, HostListener, computed, inject, signal } from '@angular/core';

import { AuthService } from '../../core/auth/auth.service';
import { Dialogs } from '../../core/browser/dialogs';
import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { ConsoleConnection } from '../../core/realtime/console-connection';
import { countLabel } from '../../core/text/polish';
import { ConsolePanel } from '../console/console-panel';
import { ConsoleStore } from '../console/console-store';
import { EditorPane } from '../editor/editor-pane';
import { EditorStore } from '../editor/editor-store';
import { Explorer } from '../explorer/explorer';
import { WorkspacesPanel } from '../workspaces/workspaces-panel';
import { WorkspacesStore } from '../workspaces/workspaces-store';

/**
 * Main view after login (layout as in the mockup):
 * file explorer | editor | console, below it the Workspace/Terminal panel, at the bottom the status bar.
 *
 * The open repository is chosen in the bottom panel (Workspace tab) and is stored in the URL (`?repo=`).
 * Without it the explorer and the console work on the whole projects directory. The Terminal tab is still a placeholder.
 *
 * State services (project, git status, editor, console, workspaces) are provided here, so they live as
 * long as this view. The console keeps running after the panel is collapsed. Changing the repository does not close open
 * editor tabs (their paths are full, so they still point to the right files).
 */
@Component({
  selector: 'app-workspace',
  imports: [Explorer, EditorPane, ConsolePanel, WorkspacesPanel],
  providers: [ProjectContext, RepoStatusStore, EditorStore, ConsoleConnection, ConsoleStore, WorkspacesStore],
  templateUrl: './workspace.html',
  styleUrl: './workspace.scss'
})
export class Workspace {
  private readonly auth = inject(AuthService);
  private readonly dialogs = inject(Dialogs);
  protected readonly editor = inject(EditorStore);
  protected readonly project = inject(ProjectContext);
  protected readonly console = inject(ConsoleStore);
  protected readonly repoStatus = inject(RepoStatusStore);
  protected readonly workspaces = inject(WorkspacesStore);

  protected readonly changesLabel = computed(() => {
    const count = this.repoStatus.changeCount();
    return count === 0 ? 'bez zmian' : countLabel(count, 'zmiana', 'zmiany', 'zmian');
  });

  protected readonly user = this.auth.user;
  protected readonly loggingOut = signal(false);
  protected readonly consoleStatus = computed(() => {
    if (this.console.connectionState() !== 'connected') {
      return 'Konsola: brak połączenia';
    }
    switch (this.console.state()) {
      case 'working':
        return 'Konsola: pracuje';
      case 'waiting':
        return 'Konsola: czeka na zgodę';
      case 'error':
        return 'Konsola: błąd';
      default:
        return 'Konsola: bezczynna';
    }
  });
  protected readonly consoleOpen = signal(true);
  protected readonly bottomOpen = signal(true);
  protected readonly bottomTab = signal<'workspace' | 'terminal'>('workspace');

  protected toggleConsole(): void {
    this.consoleOpen.update((open) => !open);
  }

  protected toggleBottom(): void {
    this.bottomOpen.update((open) => !open);
  }

  protected explorerRefreshed(): void {
    void this.repoStatus.refresh();
    void this.workspaces.refreshRepos();
  }

  protected async logout(): Promise<void> {
    if (this.loggingOut()) {
      return;
    }
    const unsaved = this.editor.unsavedCount();
    if (unsaved > 0 && !this.dialogs.confirm(`Niezapisane pliki: ${unsaved}. Wylogować i porzucić zmiany?`)) {
      return;
    }
    this.loggingOut.set(true);
    // AuthService finishes with a page reload, so the component state does not need to be restored.
    await this.auth.logout();
  }

  /** Ctrl+S / Cmd+S saves the active file, also when focus is outside the editor, instead of opening "Save Page As". */
  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.editor.save();
    }
  }
}
