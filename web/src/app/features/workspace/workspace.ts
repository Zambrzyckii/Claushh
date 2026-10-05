import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';

import { AuthService } from '../../core/auth/auth.service';
import { SessionTimer } from '../../core/auth/session-timer';
import { DeviceLayout } from '../../core/browser/device-layout';
import { Dialogs } from '../../core/browser/dialogs';
import { KeyboardInset } from '../../core/browser/keyboard-inset';
import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { ConsoleConnection } from '../../core/realtime/console-connection';
import { TerminalConnection } from '../../core/realtime/terminal-connection';
import { countLabel } from '../../core/text/format';
import { ConsolePanel } from '../console/console-panel';
import { ConsoleStore } from '../console/console-store';
import { EditorPane } from '../editor/editor-pane';
import { EditorStore } from '../editor/editor-store';
import { SecurityDialog } from '../security/security-dialog';
import { Explorer } from '../explorer/explorer';
import { TerminalPanel } from '../terminal/terminal-panel';
import { TerminalStore } from '../terminal/terminal-store';
import { WorkspacesPanel } from '../workspaces/workspaces-panel';
import { WorkspacesStore } from '../workspaces/workspaces-store';
import { PhonePanes, PhoneTab } from './phone-panes';

/**
 * Main view after login. On a desktop (layout as in the mockup): file explorer | editor | console, below it the
 * Workspace/Terminal panel, at the bottom the status bar. On a phone (docs/ARCHITECTURE.md, "Frontend" → "Phone layout"):
 * a condensed top bar with a menu, the tabs Editor · Terminal · Console (PhonePanes), the Workspace panel as a sheet.
 *
 * The open repository is chosen in the Workspace panel and is stored in the URL (`?repo=`).
 * Without it the explorer, the console and new terminals work on the whole projects directory.
 *
 * State services (project, git status, editor, console, workspaces, terminals) are provided here, so they live
 * as long as this view and survive a switch of layout. The console keeps running after the panel is collapsed,
 * terminals live on the server. Changing the repository does not close open editor tabs (their paths are full).
 */
@Component({
  selector: 'app-workspace',
  imports: [Explorer, EditorPane, ConsolePanel, WorkspacesPanel, TerminalPanel, SecurityDialog, PhonePanes],
  providers: [
    SessionTimer,
    ProjectContext,
    RepoStatusStore,
    EditorStore,
    ConsoleConnection,
    ConsoleStore,
    WorkspacesStore,
    TerminalConnection,
    TerminalStore
  ],
  host: { '[class.phone]': 'layout.phone()' },
  templateUrl: './workspace.html',
  styleUrl: './workspace.scss'
})
export class Workspace {
  private readonly auth = inject(AuthService);
  private readonly dialogs = inject(Dialogs);
  protected readonly layout = inject(DeviceLayout);
  protected readonly editor = inject(EditorStore);
  protected readonly project = inject(ProjectContext);
  protected readonly console = inject(ConsoleStore);
  protected readonly repoStatus = inject(RepoStatusStore);
  protected readonly workspaces = inject(WorkspacesStore);
  protected readonly sessionTimer = inject(SessionTimer);
  private readonly securityDialog = viewChild.required(SecurityDialog);
  private readonly workspaceSheet = viewChild<ElementRef<HTMLDialogElement>>('workspaceSheet');

  protected readonly changesLabel = computed(() => {
    const count = this.repoStatus.changeCount();
    return count === 0 ? 'no changes' : countLabel(count, 'change', 'changes');
  });

  protected readonly user = this.auth.user;
  protected readonly loggingOut = signal(false);
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
  protected readonly consoleOpen = signal(true);
  protected readonly bottomOpen = signal(true);
  protected readonly bottomTab = signal<'workspace' | 'terminal'>('workspace');
  /** The phone's active tab, in memory only: a reload starts on Editor. */
  protected readonly phoneTab = signal<PhoneTab>('editor');
  protected readonly menuOpen = signal(false);

  constructor() {
    // Started with the logged-in view; it acts only in the phone layout.
    inject(KeyboardInset);

    // Opening a repository in the Workspace sheet closes the sheet.
    effect(() => {
      this.project.path();
      untracked(() => this.workspaceSheet()?.nativeElement.close());
    });
  }

  protected toggleConsole(): void {
    this.consoleOpen.update((open) => !open);
  }

  protected toggleBottom(): void {
    this.bottomOpen.update((open) => !open);
  }

  protected openSecurity(): void {
    this.menuOpen.set(false);
    this.securityDialog().open();
  }

  protected openWorkspaceSheet(): void {
    const sheet = this.workspaceSheet()?.nativeElement;
    if (sheet && !sheet.open) {
      sheet.showModal();
    }
  }

  protected explorerRefreshed(): void {
    void this.repoStatus.refresh();
    void this.workspaces.refreshRepos();
  }

  /** `unsavedConfirmed`: the user has already agreed to discard unsaved files ("Log out everywhere"). */
  protected async logout(unsavedConfirmed = false): Promise<void> {
    if (this.loggingOut()) {
      return;
    }
    const unsaved = this.editor.unsavedCount();
    if (!unsavedConfirmed && unsaved > 0 && !this.dialogs.confirm(`Unsaved files: ${unsaved}. Log out and discard the changes?`)) {
      return;
    }
    this.loggingOut.set(true);
    // AuthService finishes with a page reload, so the component state does not need to be restored.
    await this.auth.logout();
  }

  /**
   * Esc closes the phone menu. Ctrl+S / Cmd+S saves the active file, also when focus is outside the editor, instead of
   * opening "Save Page As". Exception: in a terminal the shortcut belongs to the program in the terminal (e.g. nano).
   */
  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.menuOpen()) {
      this.menuOpen.set(false);
      return;
    }
    if (event.target instanceof Element && event.target.closest('.xterm')) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.editor.save();
    }
  }
}
