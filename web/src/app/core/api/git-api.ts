import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

import { ApiError, toApiError } from './api-error';
import { isSafeRelativePath } from './project-path';

/**
 * Git operations on a repository in the projects directory.
 * Contract: docs/ARCHITECTURE.md, section "Workspaces and git".
 */

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  /** Changed files, paths relative to the projects directory. */
  files: { path: string; status: GitFileStatus }[];
}

export interface GitPullResult {
  message: string;
  /** Files changed by the pull, paths relative to the projects directory. */
  changedPaths: string[];
}

const GIT_API = {
  status: '/api/git/status',
  pull: '/api/git/pull',
  push: '/api/git/push'
} as const;

const STATUSES: readonly GitFileStatus[] = ['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted'];

@Injectable({ providedIn: 'root' })
export class GitApi {
  private readonly http = inject(HttpClient);

  status(repo: string): Observable<GitStatus> {
    return this.guard(repo, () =>
      this.http.get<GitStatus>(GIT_API.status, { params: repoParam(repo) }).pipe(
        map((s) => ({
          branch: s.branch ?? null,
          ahead: s.ahead ?? 0,
          behind: s.behind ?? 0,
          files: (s.files ?? [])
            .filter((f) => STATUSES.includes(f.status))
            .map((f) => ({ path: f.path, status: f.status }))
        }))
      )
    );
  }

  pull(repo: string): Observable<GitPullResult> {
    return this.guard(repo, () =>
      this.http
        .post<GitPullResult>(GIT_API.pull, null, { params: repoParam(repo) })
        .pipe(map((r) => ({ message: r.message ?? '', changedPaths: r.changedPaths ?? [] })))
    );
  }

  push(repo: string): Observable<{ message: string }> {
    return this.guard(repo, () =>
      this.http
        .post<{ message: string }>(GIT_API.push, null, { params: repoParam(repo) })
        .pipe(map((r) => ({ message: r.message ?? '' })))
    );
  }

  private guard<T>(repo: string, request: () => Observable<T>): Observable<T> {
    if (!isSafeRelativePath(repo) || repo === '') {
      return throwError(() => new ApiError('invalid'));
    }
    return request().pipe(catchError((e: unknown) => throwError(() => toApiError(e))));
  }
}

function repoParam(repo: string): HttpParams {
  return new HttpParams().set('repo', repo);
}
