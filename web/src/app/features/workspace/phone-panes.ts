import { Component, computed, inject, linkedSignal, model } from '@angular/core';

import { ConsolePanel } from '../console/console-panel';
import { EditorPane } from '../editor/editor-pane';
import { EditorStore } from '../editor/editor-store';
import { TerminalPanel } from '../terminal/terminal-panel';
import { SideBar } from './side-bar';
import { SideView, WorkbenchState } from './workbench-state';

export type PhoneTab = 'editor' | 'terminal' | 'console';

/**
 * The phone layout's middle (docs/ARCHITECTURE.md, "Frontend" → "Phone layout"): the tabs Editor, Terminal and Console
 * and their panes. Inactive panes are hidden and inert (they cannot hold the focus), never destroyed, so Monaco and
 * xterm keep their state and size; the terminal mounts on its first visit, because opening it starts a tmux session.
 * The side bar (Explorer, Source Control) is a drawer in the Editor tab and stays mounted, so it keeps its expanded
 * folders.
 */
@Component({
  selector: 'app-phone-panes',
  imports: [EditorPane, SideBar, TerminalPanel, ConsolePanel],
  templateUrl: './phone-panes.html',
  styleUrl: './phone-panes.scss'
})
export class PhonePanes {
  private readonly editor = inject(EditorStore);
  protected readonly state = inject(WorkbenchState);

  readonly tab = model<PhoneTab>('editor');

  protected readonly tabs: readonly { id: PhoneTab; label: string }[] = [
    { id: 'editor', label: 'Editor' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'console', label: 'Console' }
  ];
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
    this.state.drawerOpen.set(false);
  }

  /** The Explorer button: the drawer on that view, or closed when it already shows it. */
  protected toggle(view: SideView): void {
    if (this.state.drawerOpen() && this.state.view() === view) {
      this.state.drawerOpen.set(false);
    } else {
      this.state.show(view);
    }
  }

  protected save(): void {
    void this.editor.save();
  }
}
