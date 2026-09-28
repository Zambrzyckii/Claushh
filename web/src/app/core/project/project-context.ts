import { Injectable, computed, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { baseName } from '../api/project-path';

/**
 * The currently open project and events shared by the view's panels.
 *
 * `path` is the repository path relative to the projects directory. An empty string means the whole projects directory
 * (that is the case until the Workspace panel lets you choose a repository). The explorer shows this directory,
 * and the console runs Claude Code in it.
 *
 * `filesChanged` announces files changed outside the editor (e.g. by the console), so that the explorer
 * and the editor can refresh. Provided in the Workspace component.
 */
@Injectable()
export class ProjectContext {
  readonly path = signal('');
  readonly label = computed(() => (this.path() === '' ? 'katalog projektów' : baseName(this.path())));

  private readonly changes = new Subject<readonly string[]>();
  readonly filesChanged = this.changes.asObservable();

  announceFilesChanged(paths: readonly string[]): void {
    if (paths.length > 0) {
      this.changes.next(paths);
    }
  }
}
