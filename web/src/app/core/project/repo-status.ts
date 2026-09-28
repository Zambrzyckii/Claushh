import { DOCUMENT, DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, firstValueFrom, fromEvent, merge } from 'rxjs';

import { ApiError } from '../api/api-error';
import { GitApi, GitFileStatus, GitStatus } from '../api/git-api';
import { ProjectContext } from './project-context';

/** Letters as in VS Code: M modified, A added, D deleted, R renamed, U untracked, ! conflict. */
const LETTERS: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!'
};

/** Marker for a directory that contains changed files. */
export const DIRECTORY_MARK = '•';

/**
 * Git status of the open repository: branch, changed files and badges for the explorer.
 *
 * Refreshes on a repository change, after file changes (console, pull, save in the editor)
 * and after returning to the browser tab (e.g. after working in the terminal on another device).
 * There is no status for the projects directory (no open repo).
 * Provided in the Workspace component.
 */
@Injectable()
export class RepoStatusStore {
  private readonly git = inject(GitApi);
  private readonly project = inject(ProjectContext);

  private readonly current = signal<GitStatus | null>(null);
  private request = 0;
  private loadedRepo: string | null = null;

  readonly status = this.current.asReadonly();
  readonly branch = computed(() => this.current()?.branch ?? null);
  readonly changeCount = computed(() => this.current()?.files.length ?? 0);

  /** Path → status letter (files) or `•` (directories containing changes). */
  readonly decorations = computed(() => {
    const marks = new Map<string, string>();
    const status = this.current();
    if (!status) {
      return marks;
    }
    for (const file of status.files) {
      marks.set(file.path, LETTERS[file.status]);
    }
    for (const file of status.files) {
      let slash = file.path.lastIndexOf('/');
      while (slash > 0) {
        const directory = file.path.slice(0, slash);
        if (!marks.has(directory)) {
          marks.set(directory, DIRECTORY_MARK);
        }
        slash = directory.lastIndexOf('/');
      }
    }
    return marks;
  });

  constructor() {
    effect(() => {
      const repo = this.project.path();
      untracked(() => void this.load(repo));
    });

    const document = inject(DOCUMENT);
    merge(this.project.filesChanged, this.project.filesSaved, fromEvent(document, 'visibilitychange'))
      .pipe(debounceTime(300), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => {
        if (document.visibilityState !== 'hidden') {
          void this.refresh();
        }
      });
  }

  refresh(): Promise<void> {
    return this.load(this.project.path());
  }

  private async load(repo: string): Promise<void> {
    const request = ++this.request;
    if (repo !== this.loadedRepo) {
      // Another repository: the old status must not be visible even for a moment.
      this.loadedRepo = repo;
      this.current.set(null);
    }
    if (repo === '') {
      this.current.set(null);
      return;
    }
    try {
      const status = await firstValueFrom(this.git.status(repo));
      if (request === this.request) {
        this.current.set(status);
      }
    } catch (error) {
      // A directory that is not a repository (404) has no status. Other errors keep the last known state.
      if (request === this.request && error instanceof ApiError && error.kind === 'not-found') {
        this.current.set(null);
      }
    }
  }
}
