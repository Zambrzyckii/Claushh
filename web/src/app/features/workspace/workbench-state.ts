import { Injectable, effect, inject, signal, untracked } from '@angular/core';

import { DeviceLayout } from '../../core/browser/device-layout';
import { ProjectContext } from '../../core/project/project-context';
import { CONSOLE, PANEL, SIDE_BAR } from './panel-sizes';

/** The views of the side bar (docs/ARCHITECTURE.md, "Frontend" → "Layout"). */
export type SideView = 'explorer' | 'search' | 'scm';

/**
 * What the VS Code-like shell shows (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the primary side bar and its view, the
 * bottom panel, the console, on a phone the drawer that holds the side bar, and the panels' sizes. In memory only, so a
 * reload starts with the side bar on Explorer, the panel closed (the terminal hub connects only when it is first shown),
 * the console open and the sizes at start. Provided in Workspace.
 */
@Injectable()
export class WorkbenchState {
  private readonly layout = inject(DeviceLayout);

  readonly sideBarOpen = signal(true);
  readonly panelOpen = signal(false);
  readonly consoleOpen = signal(true);
  readonly view = signal<SideView>('explorer');
  readonly drawerOpen = signal(false);
  /** OPEN EDITORS in the Explorer view: collapsed at start, as in VS Code. */
  readonly openEditorsExpanded = signal(false);
  /** Counts the requests to focus the search field (`show('search')`); SearchView acts on a new one. */
  readonly searchFocus = signal(0);

  /**
   * The widths and the height chosen by dragging the panels' edges (Sash). Workspace fits them to the window
   * (fitPanels), so a narrow window never changes what was chosen.
   */
  readonly sideBarWidth = signal(SIDE_BAR.initial);
  readonly consoleWidth = signal(CONSOLE.initial);
  readonly panelHeight = signal(PANEL.initial);
  /** True while a panel's edge is dragged: the terminals keep their size and fit once at the end (TerminalView). */
  readonly resizing = signal(false);

  constructor() {
    // Opening a repository closes the phone's drawer, as opening a file does.
    const project = inject(ProjectContext);
    effect(() => {
      project.path();
      untracked(() => this.drawerOpen.set(false));
    });
  }

  /** Shows a view: in the side bar on a desktop, in the drawer on a phone. Search also puts the focus in its field. */
  show(view: SideView): void {
    this.view.set(view);
    if (view === 'search') {
      this.searchFocus.update((request) => request + 1);
    }
    if (this.layout.phone()) {
      this.drawerOpen.set(true);
    } else {
      this.sideBarOpen.set(true);
    }
  }
}
