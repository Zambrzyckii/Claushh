import { Component, inject } from '@angular/core';

import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { EditorStore } from '../editor/editor-store';
import { OpenEditors } from '../editor/open-editors';
import { Explorer } from '../explorer/explorer';
import { SourceControlView } from '../workspaces/source-control-view';
import { WorkspacesStore } from '../workspaces/workspaces-store';
import { SideView, WorkbenchState } from './workbench-state';

/**
 * The primary side bar (docs/ARCHITECTURE.md, "Frontend" → "Layout"): VS Code's activity bar on top (Explorer, Source
 * Control, with their badges) and the views below; Explorer starts with OPEN EDITORS. Every view stays mounted and
 * the inactive one is hidden, so the explorer keeps its expanded folders. Used by both layouts: the desktop's left
 * column and the phone's drawer, which closes when a file opens from a view.
 */
@Component({
  selector: 'app-side-bar',
  imports: [Explorer, OpenEditors, SourceControlView],
  templateUrl: './side-bar.html',
  styleUrl: './side-bar.scss'
})
export class SideBar {
  protected readonly state = inject(WorkbenchState);
  protected readonly project = inject(ProjectContext);
  protected readonly editor = inject(EditorStore);
  protected readonly repoStatus = inject(RepoStatusStore);
  private readonly workspaces = inject(WorkspacesStore);

  protected readonly views: readonly { id: SideView; label: string; icon: string }[] = [
    { id: 'explorer', label: 'Explorer', icon: 'files' },
    { id: 'scm', label: 'Source Control', icon: 'source-control' }
  ];

  /** Explorer: the unsaved files (as VS Code); Source Control: the changes of the open repository. */
  protected badge(view: SideView): number {
    return view === 'explorer' ? this.editor.unsavedCount() : this.repoStatus.changeCount();
  }

  protected openFile(path: string): void {
    void this.editor.open(path);
    this.state.drawerOpen.set(false);
  }

  protected explorerRefreshed(): void {
    void this.repoStatus.refresh();
    void this.workspaces.refreshRepos();
  }
}
