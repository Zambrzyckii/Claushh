import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, catchError, map, of, startWith, switchMap, timer } from 'rxjs';

import { ApiError } from '../../core/api/api-error';
import { SearchApi, SearchRequest, SearchResult } from '../../core/api/search-api';
import { ProjectContext } from '../../core/project/project-context';

/** Typing waits this long before it searches; Enter, a toggle and Refresh search at once. */
export const SEARCH_DEBOUNCE_MS = 300;

export type SearchOption = 'matchCase' | 'wholeWord' | 'regex';

export type SearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; result: SearchResult }
  | { status: 'error'; message: string };

/**
 * State of the Search view (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the query, its toggles and globs, the results
 * and the folded files. Every change starts a new search and drops the one before it (`switchMap`, which cancels its
 * request); typing waits 300 ms. The search covers the open repository, or the projects directory, and runs again when
 * that changes. Provided in Workspace, so the results survive a switch of view or layout.
 */
@Injectable()
export class SearchStore {
  private readonly api = inject(SearchApi);
  private readonly project = inject(ProjectContext);

  readonly query = signal('');
  readonly matchCase = signal(false);
  readonly wholeWord = signal(false);
  readonly regex = signal(false);
  readonly include = signal('');
  readonly exclude = signal('');
  readonly detailsOpen = signal(false);
  /** Files whose matches are folded. */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  private readonly stateSignal = signal<SearchState>({ status: 'idle' });
  readonly state = this.stateSignal.asReadonly();
  readonly result = computed(() => {
    const state = this.stateSignal();
    return state.status === 'done' ? state.result : null;
  });

  /** Each value starts a search after that many ms. */
  private readonly runs = new Subject<number>();

  constructor() {
    this.runs
      .pipe(
        switchMap((delay) => this.search(delay)),
        takeUntilDestroyed(inject(DestroyRef))
      )
      .subscribe((state) => {
        this.stateSignal.set(state);
        if (state.status === 'done') {
          this.collapsed.set(new Set());
        }
      });

    // Another repository: the same query searches it at once.
    effect(() => {
      this.project.path();
      untracked(() => this.runs.next(0));
    });
  }

  setQuery(value: string): void {
    this.query.set(value);
    this.runs.next(SEARCH_DEBOUNCE_MS);
  }

  setGlob(which: 'include' | 'exclude', value: string): void {
    this[which].set(value);
    this.runs.next(SEARCH_DEBOUNCE_MS);
  }

  toggle(option: SearchOption): void {
    this[option].update((on) => !on);
    this.runs.next(0);
  }

  /** Enter and Refresh. */
  searchNow(): void {
    this.runs.next(0);
  }

  clear(): void {
    this.query.set('');
    this.runs.next(0);
  }

  toggleFile(path: string): void {
    this.collapsed.update((paths) => {
      const next = new Set(paths);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  }

  collapseAll(): void {
    this.collapsed.set(new Set(this.result()?.files.map((file) => file.path) ?? []));
  }

  private search(delay: number): Observable<SearchState> {
    const request = this.request();
    if (!request) {
      return of<SearchState>({ status: 'idle' });
    }
    return timer(delay).pipe(
      switchMap(() =>
        this.api.search(request).pipe(
          map((result): SearchState => ({ status: 'done', result })),
          catchError((error: unknown) => of<SearchState>({ status: 'error', message: errorText(error, request.regex) })),
          startWith<SearchState>({ status: 'searching' })
        )
      )
    );
  }

  private request(): SearchRequest | null {
    const query = this.query();
    return query === ''
      ? null
      : {
          path: this.project.path(),
          query,
          matchCase: this.matchCase(),
          wholeWord: this.wholeWord(),
          regex: this.regex(),
          include: this.include(),
          exclude: this.exclude()
        };
  }
}

function errorText(error: unknown, regex: boolean): string {
  return regex && error instanceof ApiError && error.kind === 'invalid'
    ? 'Invalid or unsupported regular expression.'
    : 'Could not search.';
}
