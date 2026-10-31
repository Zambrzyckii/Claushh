import { Component, inject, output } from '@angular/core';

import { baseName, directoryInRepo } from '../../core/api/project-path';
import { fileIconFor } from '../../core/icons/file-icons';
import { RepoStatusStore, STATUS_LETTERS } from '../../core/project/repo-status';
import { EditorStore } from '../editor/editor-store';
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
  /** A change was clicked, emitted before its file is opened. */
  readonly opened = output<void>();
  protected readonly letters = STATUS_LETTERS;

  protected readonly name = baseName;

  protected readonly directory = directoryInRepo;

  protected readonly icon = fileIconFor;

  protected async open(path: string): Promise<void> {
    this.opened.emit();
    await this.editor.open(path);
    const doc = this.editor.active();
    if (doc?.path === path && doc.diff === null) {
      await this.editor.toggleDiff(path);
    }
  }
}
