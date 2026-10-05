import { Component, computed, inject, linkedSignal, model, signal } from '@angular/core';

import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { ConsolePanel } from '../console/console-panel';
import { EditorPane } from '../editor/editor-pane';
import { EditorStore } from '../editor/editor-store';
import { Explorer } from '../explorer/explorer';
import { TerminalPanel } from '../terminal/terminal-panel';
import { WorkspacesStore } from '../workspaces/workspaces-store';

export type PhoneTab = 'editor' | 'terminal' | 'console';

/**
 * The phone layout's middle (docs/ARCHITECTURE.md, "Frontend" → "Phone layout"): the tabs Editor, Terminal and Console
 * and their panes. Inactive panes are hidden and inert (they cannot hold the focus), never destroyed, so Monaco and
 * xterm keep their state and size; the terminal mounts on its first visit, because opening it starts a tmux session.
 * The explorer is a drawer in the Editor tab and stays mounted, so it keeps its expanded folders.
 */
@Component({
  selector: 'app-phone-panes',
  imports: [EditorPane, Explorer, TerminalPanel, ConsolePanel],
  templateUrl: './phone-panes.html',
  styleUrl: './phone-panes.scss'
})
export class PhonePanes {
  protected readonly editor = inject(EditorStore);
  protected readonly project = inject(ProjectContext);
  protected readonly repoStatus = inject(RepoStatusStore);
  private readonly workspaces = inject(WorkspacesStore);

  readonly tab = model<PhoneTab>('editor');

  protected readonly tabs: readonly { id: PhoneTab; label: string }[] = [
    { id: 'editor', label: 'Editor' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'console', label: 'Console' }
  ];
  protected readonly drawerOpen = signal(false);
  /** Turns true on the first visit of the Terminal tab and stays true. */
  protected readonly terminalVisited = linkedSignal<PhoneTab, boolean>({
    source: this.tab,
    computation: (tab, previous) => (previous?.value ?? false) || tab === 'terminal'
  });
  protected readonly canSave = computed(() => {
    const doc = this.editor.active();
    return !!doc && doc.status === 'ready' && this.editor.isDirty(doc.path) && !doc.saving && !doc.conflict;
  });

  protected select(tab: PhoneTab): void {
    this.tab.set(tab);
    this.drawerOpen.set(false);
  }

  protected open(path: string): void {
    void this.editor.open(path);
    this.drawerOpen.set(false);
  }

  protected save(): void {
    void this.editor.save();
  }

  protected explorerRefreshed(): void {
    void this.repoStatus.refresh();
    void this.workspaces.refreshRepos();
  }
}
