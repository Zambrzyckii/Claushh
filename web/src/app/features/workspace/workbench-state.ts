import { Injectable, effect, inject, signal, untracked } from '@angular/core';

import { DeviceLayout } from '../../core/browser/device-layout';
import { ProjectContext } from '../../core/project/project-context';

/** The views of the side bar (docs/ARCHITECTURE.md, "Frontend" → "Layout"). */
export type SideView = 'explorer' | 'search' | 'scm';

/**
 * What the VS Code-like shell shows (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the primary side bar and its view, the
 * bottom panel, the console, and on a phone the drawer that holds the side bar. In memory only, so a reload starts with
 * the side bar on Explorer, the panel closed (the terminal hub connects only when it is first shown) and the console
 * open. Provided in Workspace.
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
