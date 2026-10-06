import { Component, HostListener, inject, signal, viewChild } from '@angular/core';

import { AuthService } from '../../core/auth/auth.service';
import { SessionTimer } from '../../core/auth/session-timer';
import { DeviceLayout } from '../../core/browser/device-layout';
import { Dialogs } from '../../core/browser/dialogs';
import { KeyboardInset } from '../../core/browser/keyboard-inset';
import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { ConsoleConnection } from '../../core/realtime/console-connection';
import { TerminalConnection } from '../../core/realtime/terminal-connection';
import { ConsolePanel } from '../console/console-panel';
import { ConsoleStore } from '../console/console-store';
import { EditorPane } from '../editor/editor-pane';
import { EditorStore } from '../editor/editor-store';
import { SecurityDialog } from '../security/security-dialog';
import { TerminalPanel } from '../terminal/terminal-panel';
import { TerminalStore } from '../terminal/terminal-store';
import { WorkspacesStore } from '../workspaces/workspaces-store';
import { PhonePanes, PhoneTab } from './phone-panes';
import { SideBar } from './side-bar';
import { StatusBar } from './status-bar';
import { TitleBar } from './title-bar';
import { WorkbenchState } from './workbench-state';

/**
 * Main view after login, laid out as VS Code (docs/ARCHITECTURE.md, "Frontend" → "Layout"). Desktop: the title bar, the
 * primary side bar (Explorer, Source Control), the editor with the bottom panel (the terminal) under it, the console as
 * the secondary side bar, and the status bar. Phone ("Phone layout"): a condensed top bar, the tabs Editor · Terminal ·
 * Console (PhonePanes) with the side bar as a drawer, and the status bar.
 *
 * The open repository is chosen in Source Control and is stored in the URL (`?repo=`). Without it the explorer, the
 * console and new terminals work on the whole projects directory.
 *
 * State services (project, git status, editor, console, workspaces, terminals, what the shell shows) are provided here,
 * so they live as long as this view and survive a switch of layout. The console keeps running while it is hidden,
 * terminals live on the server. Changing the repository does not close open editor tabs (their paths are full).
 */
@Component({
  selector: 'app-workspace',
  imports: [TitleBar, SideBar, EditorPane, TerminalPanel, ConsolePanel, StatusBar, SecurityDialog, PhonePanes],
  providers: [
    SessionTimer,
    ProjectContext,
    RepoStatusStore,
    EditorStore,
    ConsoleConnection,
    ConsoleStore,
    WorkspacesStore,
    TerminalConnection,
    TerminalStore,
    WorkbenchState
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
  protected readonly state = inject(WorkbenchState);
  private readonly securityDialog = viewChild.required(SecurityDialog);

  protected readonly loggingOut = signal(false);
  /** The phone's active tab, in memory only: a reload starts on Editor. */
  protected readonly phoneTab = signal<PhoneTab>('editor');

  constructor() {
    // Started with the logged-in view; it acts only in the phone layout.
    inject(KeyboardInset);
  }

  protected openSecurity(): void {
    this.securityDialog().open();
  }

  /** The phone's repository button: the Editor tab with the drawer on Source Control. */
  protected showRepository(): void {
    this.phoneTab.set('editor');
    this.state.show('scm');
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
   * Ctrl+S / Cmd+S saves the active file, also when focus is outside the editor, instead of opening "Save Page As".
   * Exception: in a terminal the shortcut belongs to the program in the terminal (e.g. nano). Esc closes the menu in
   * TitleBar.
   */
  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (event.target instanceof Element && event.target.closest('.xterm')) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.editor.save();
    }
  }
}
