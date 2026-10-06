import { Component, DOCUMENT, DestroyRef, HostListener, Injector, afterNextRender, inject, signal, viewChild } from '@angular/core';

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
import { SearchStore } from '../search/search-store';
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
 * primary side bar (Explorer, Search, Source Control), the editor with the bottom panel (the terminal) under it, the console as
 * the secondary side bar, and the status bar. Phone ("Phone layout"): a condensed top bar, the tabs Editor · Terminal ·
 * Console (PhonePanes) with the side bar as a drawer, and the status bar.
 *
 * The open repository is chosen in Source Control and is stored in the URL (`?repo=`). Without it the explorer, the
 * console and new terminals work on the whole projects directory.
 *
 * State services (project, git status, editor, console, workspaces, terminals, search, what the shell shows) are provided here,
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
    SearchStore,
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
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly securityDialog = viewChild.required(SecurityDialog);
  private readonly consolePanel = viewChild(ConsolePanel);

  protected readonly loggingOut = signal(false);
  /** The phone's active tab, in memory only: a reload starts on Editor. */
  protected readonly phoneTab = signal<PhoneTab>('editor');
  /** Where the focus was when Ctrl+Alt+B last opened the console; closing it with the key brings the focus back. */
  private focusBeforeConsole: HTMLElement | null = null;

  constructor() {
    // Started with the logged-in view; it acts only in the phone layout.
    inject(KeyboardInset);

    // The capture phase runs before Monaco and xterm see the key (toggleConsoleByKey).
    const listener = (event: KeyboardEvent) => this.toggleConsoleByKey(event);
    this.document.addEventListener('keydown', listener, { capture: true });
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('keydown', listener, { capture: true }));
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
   * TitleBar; Ctrl+Alt+B (the console) is `toggleConsoleByKey`.
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

  /**
   * Ctrl+Alt+B / Cmd+Option+B shows and hides the console, VS Code's key for the secondary side bar. Unlike Ctrl+S it
   * also works in a terminal: this listener runs in the capture phase on the document and stops the event there, so
   * neither Monaco nor xterm (which would send the key to the shell) receives it. `stopPropagation` only: SessionTimer's
   * capture listener on the document still sees the key. A held key toggles once. Not in the phone layout (the console
   * is a tab there) and not while a dialog is open.
   */
  private toggleConsoleByKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey || event.code !== 'KeyB') {
      return;
    }
    if (this.layout.phone() || this.document.querySelector('dialog[open]')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) {
      return;
    }
    const focused = this.document.activeElement instanceof HTMLElement ? this.document.activeElement : null;
    if (this.state.consoleOpen()) {
      // The focus leaves a console that slides out: back to where it was before the key opened it, or nowhere.
      const inConsole = focused?.closest('app-console-panel') ? focused : null;
      const back = this.focusBeforeConsole;
      this.focusBeforeConsole = null;
      this.state.consoleOpen.set(false);
      if (inConsole && back?.isConnected) {
        back.focus();
      } else {
        inConsole?.blur();
      }
    } else {
      this.focusBeforeConsole = focused;
      this.state.consoleOpen.set(true);
      afterNextRender(() => this.consolePanel()?.focusPrompt(), { injector: this.injector });
    }
  }
}
