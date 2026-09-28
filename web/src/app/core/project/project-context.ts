import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject } from 'rxjs';

import { baseName, isSafeRelativePath } from '../api/project-path';

/**
 * The currently open repository and events shared by the view's panels.
 *
 * `path` is the repository path relative to the projects directory (e.g. `studia/lab-3-sieci`), kept in the page
 * address as `?repo=…`. Thanks to that it survives a reload, and after session expiry `returnUrl` goes back to
 * the same repository. An empty string (no parameter) means the whole projects directory.
 * The explorer shows this directory, the console runs Claude Code in it, and the git status refers to this repo.
 *
 * Events:
 * - `filesChanged`: files changed outside the editor (console, pull). The explorer and the editor refresh.
 * - `filesSaved`: files saved by the editor. Only the git status refreshes (the editor already has the current content).
 *
 * Provided in the Workspace component.
 */
@Injectable()
export class ProjectContext {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  readonly path = computed(() => {
    const repo = this.query().get('repo') ?? '';
    return isSafeRelativePath(repo) ? repo : '';
  });
  readonly label = computed(() => (this.path() === '' ? 'katalog projektów' : baseName(this.path())));

  private readonly changes = new Subject<readonly string[]>();
  private readonly saves = new Subject<readonly string[]>();
  readonly filesChanged = this.changes.asObservable();
  readonly filesSaved = this.saves.asObservable();

  /** Opens a repository (or the whole projects directory for `''`) by changing the `repo` parameter in the address. */
  open(path: string): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { repo: path === '' ? null : path },
      queryParamsHandling: 'merge'
    });
  }

  announceFilesChanged(paths: readonly string[]): void {
    if (paths.length > 0) {
      this.changes.next(paths);
    }
  }

  announceFilesSaved(paths: readonly string[]): void {
    if (paths.length > 0) {
      this.saves.next(paths);
    }
  }
}
