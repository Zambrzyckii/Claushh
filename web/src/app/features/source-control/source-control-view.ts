import { Component, inject } from '@angular/core';

import { baseName } from '../../core/api/project-path';
import { fileIconUrl } from '../../core/icons/file-icons';
import { RepoStatusStore, STATUS_LETTERS } from '../../core/project/repo-status';
import { EditorStore } from '../editor/editor-store';
import { WorkbenchState } from '../workspace/workbench-state';
import { WorkspacesPanel } from './workspaces-panel';

/**
 * The Source Control view of the side bar (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the workspaces and repositories
 * (WorkspacesPanel) and, for the open repository, its CHANGES. A click opens a changed file with its changes shown; a
 * deleted file cannot be opened.
 */
@Component({
  selector: 'app-source-control-view',
  imports: [WorkspacesPanel],
  templateUrl: './source-control-view.html',
  styleUrl: './source-control-view.scss'
})
export class SourceControlView {
  protected readonly repoStatus = inject(RepoStatusStore);
  private readonly editor = inject(EditorStore);
  private readonly state = inject(WorkbenchState);
  protected readonly letters = STATUS_LETTERS;

  protected name(path: string): string {
    return baseName(path);
  }

  /** The file's directory inside its repository (paths start with workspace/repository). */
  protected directory(path: string): string {
    return path.split('/').slice(2, -1).join('/');
  }

  protected icon(path: string): string {
    return fileIconUrl(baseName(path));
  }

  protected async open(path: string): Promise<void> {
    this.state.drawerOpen.set(false);
    await this.editor.open(path);
    const doc = this.editor.active();
    if (doc?.path === path && doc.diff === null) {
      await this.editor.toggleDiff(path);
    }
  }
}
