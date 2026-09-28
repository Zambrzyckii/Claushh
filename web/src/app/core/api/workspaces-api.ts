import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

import { ApiError, toApiError } from './api-error';
import { isSafeRelativePath } from './project-path';

/**
 * Workspaces (top-level directories in the projects directory) and their repositories.
 * Contract: docs/ARCHITECTURE.md, section "Workspaces and git".
 */

export interface WorkspaceInfo {
  /** Display name, e.g. "Studia". */
  name: string;
  /** Directory relative to the projects directory, e.g. `studia`. */
  path: string;
  repoCount: number;
}

export interface RepoSummary {
  name: string;
  /** Repository path relative to the projects directory, e.g. `studia/lab-3-sieci`. */
  path: string;
  /** Current branch. `null` with a detached HEAD. */
  branch: string | null;
  /** Number of changed files (including untracked ones). */
  changes: number;
  /** Remote branch, e.g. `origin/main`. `null` when the branch has none. */
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommit: { message: string; date: string } | null;
}

const WORKSPACES_API = {
  workspaces: '/api/workspaces',
  repos: '/api/repos',
  clone: '/api/repos/clone'
} as const;

@Injectable({ providedIn: 'root' })
export class WorkspacesApi {
  private readonly http = inject(HttpClient);

  list(): Observable<WorkspaceInfo[]> {
    return this.http.get<WorkspaceInfo[]>(WORKSPACES_API.workspaces).pipe(
      map((list) => list.map(toWorkspace)),
      catchError((e: unknown) => throwError(() => toApiError(e)))
    );
  }

  create(name: string): Observable<WorkspaceInfo> {
    return this.http.post<WorkspaceInfo>(WORKSPACES_API.workspaces, { name }).pipe(
      map(toWorkspace),
      catchError((e: unknown) => throwError(() => toApiError(e)))
    );
  }

  repos(workspacePath: string): Observable<RepoSummary[]> {
    if (!isSafeRelativePath(workspacePath) || workspacePath === '') {
      return throwError(() => new ApiError('invalid'));
    }
    return this.http
      .get<RepoSummary[]>(WORKSPACES_API.repos, { params: new HttpParams().set('workspace', workspacePath) })
      .pipe(
        map((list) => list.map(toRepo)),
        catchError((e: unknown) => throwError(() => toApiError(e)))
      );
  }

  clone(workspacePath: string, url: string): Observable<RepoSummary> {
    if (!isSafeRelativePath(workspacePath) || workspacePath === '') {
      return throwError(() => new ApiError('invalid'));
    }
    return this.http.post<RepoSummary>(WORKSPACES_API.clone, { workspace: workspacePath, url }).pipe(
      map(toRepo),
      catchError((e: unknown) => throwError(() => toApiError(e)))
    );
  }
}

function toWorkspace(w: WorkspaceInfo): WorkspaceInfo {
  return { name: w.name, path: w.path, repoCount: w.repoCount };
}

function toRepo(r: RepoSummary): RepoSummary {
  return {
    name: r.name,
    path: r.path,
    branch: r.branch ?? null,
    changes: r.changes ?? 0,
    upstream: r.upstream ?? null,
    ahead: r.ahead ?? 0,
    behind: r.behind ?? 0,
    lastCommit: r.lastCommit ? { message: r.lastCommit.message, date: r.lastCommit.date } : null
  };
}
