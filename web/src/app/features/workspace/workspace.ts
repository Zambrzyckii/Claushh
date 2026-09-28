import { Component, HostListener, computed, inject, signal } from '@angular/core';

import { AuthService } from '../../core/auth/auth.service';
import { Dialogs } from '../../core/browser/dialogs';
import { ProjectContext } from '../../core/project/project-context';
import { ConsoleConnection } from '../../core/realtime/console-connection';
import { ConsolePanel } from '../console/console-panel';
import { ConsoleStore } from '../console/console-store';
import { EditorPane } from '../editor/editor-pane';
import { EditorStore } from '../editor/editor-store';
import { Explorer } from '../explorer/explorer';

/**
 * Main view after login (layout as in the mockup):
 * file explorer | editor | console, below it the Workspace/Terminal panel, at the bottom the status bar.
 *
 * The bottom panel is still a placeholder (stage 4, see docs/PLAN.md). Until a repository can be chosen in it,
 * the project is the whole projects directory (ProjectContext.path = '').
 *
 * State services (project, editor, console) are provided here, so they live as long as this view.
 * The console keeps running after the panel is collapsed.
 */
@Component({
  selector: 'app-workspace',
  imports: [Explorer, EditorPane, ConsolePanel],
  providers: [ProjectContext, EditorStore, ConsoleConnection, ConsoleStore],
  templateUrl: './workspace.html',
  styleUrl: './workspace.scss'
})
export class Workspace {
  private readonly auth = inject(AuthService);
  private readonly dialogs = inject(Dialogs);
  protected readonly editor = inject(EditorStore);
  protected readonly project = inject(ProjectContext);
  protected readonly console = inject(ConsoleStore);

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
