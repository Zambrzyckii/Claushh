import { Component, HostListener, inject, signal } from '@angular/core';

import { AuthService } from '../../core/auth/auth.service';
import { Dialogs } from '../../core/browser/dialogs';
import { EditorPane } from '../editor/editor-pane';
import { EditorStore } from '../editor/editor-store';
import { Explorer } from '../explorer/explorer';

/**
 * Main view after login (layout as in the mockup):
 * file explorer | editor | console, below it the Workspace/Terminal panel, at the bottom the status bar.
 *
 * The console and the bottom panel are still placeholders (stages 3 and 4, see docs/PLAN.md).
 * For now the explorer shows the whole projects directory. Choosing a workspace and repository will come in stage 4.
 */
@Component({
  selector: 'app-workspace',
  imports: [Explorer, EditorPane],
  providers: [EditorStore],
  templateUrl: './workspace.html',
  styleUrl: './workspace.scss'
})
export class Workspace {
  private readonly auth = inject(AuthService);
  private readonly dialogs = inject(Dialogs);
  protected readonly editor = inject(EditorStore);

  protected readonly user = this.auth.user;
  protected readonly loggingOut = signal(false);
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
