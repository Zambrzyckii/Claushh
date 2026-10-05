import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

import { isSafeRelativePath } from './project-path';

/**
 * Access to files in the projects directory through the API.
 * Contract: docs/ARCHITECTURE.md, section "Files".
 */

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

export interface FileContent {
  path: string;
  content: string;
  /** Opaque file version identifier (e.g. a hash). Used to detect conflicts on save. */
  version: string;
}

export type FileErrorKind = 'not-found' | 'too-large' | 'binary' | 'conflict' | 'invalid-path' | 'network' | 'server';

/** File operation error. On a conflict, `currentVersion` is the file version that is on disk now. */
export class FileApiError extends Error {
  constructor(
    readonly kind: FileErrorKind,
    readonly currentVersion?: string
  ) {
    super(kind);
  }
}

const FILES_API = {
  list: '/api/files/list',
  content: '/api/files/content'
} as const;

@Injectable({ providedIn: 'root' })
export class FilesApi {
  private readonly http = inject(HttpClient);

  list(path: string): Observable<DirectoryEntry[]> {
    return this.guard(path, () =>
      this.http.get<DirectoryEntry[]>(FILES_API.list, { params: pathParam(path) }).pipe(
        map((entries) =>
          entries.map((e) => ({ name: e.name, path: e.path, kind: e.kind === 'directory' ? 'directory' : 'file' }) as const)
        )
      )
    );
  }

  read(path: string): Observable<FileContent> {
    return this.guard(path, () =>
      this.http
        .get<FileContent>(FILES_API.content, { params: pathParam(path) })
        .pipe(map((f) => ({ path: f.path, content: f.content, version: f.version })))
    );
  }

  /** Saves the file, provided `baseVersion` is still on disk. Otherwise a `conflict` error. */
  write(path: string, content: string, baseVersion: string): Observable<{ version: string }> {
    return this.guard(path, () =>
      this.http
        .put<{ version: string }>(FILES_API.content, { content, baseVersion }, { params: pathParam(path) })
        .pipe(map((r) => ({ version: r.version })))
    );
  }

  private guard<T>(path: string, request: () => Observable<T>): Observable<T> {
    if (!isSafeRelativePath(path)) {
      return throwError(() => new FileApiError('invalid-path'));
    }
    return request().pipe(catchError((error: unknown) => throwError(() => toFileApiError(error))));
  }
}

function pathParam(path: string): HttpParams {
  return new HttpParams().set('path', path);
}

function toFileApiError(error: unknown): FileApiError {
  if (!(error instanceof HttpErrorResponse)) {
    return new FileApiError('server');
  }
  switch (error.status) {
    case 0:
      return new FileApiError('network');
    case 400:
      return new FileApiError('invalid-path');
    case 404:
      return new FileApiError('not-found');
    case 409: {
      const current = (error.error as { currentVersion?: unknown } | null)?.currentVersion;
      return new FileApiError('conflict', typeof current === 'string' ? current : undefined);
    }
    case 413:
      return new FileApiError('too-large');
    case 415:
      return new FileApiError('binary');
    default:
      return new FileApiError('server');
  }
}

/** Message for the user. */
export function fileErrorMessage(kind: FileErrorKind): string {
  switch (kind) {
    case 'not-found':
      return 'The file does not exist.';
    case 'too-large':
      return 'The file is too large to open in the editor.';
    case 'binary':
      return 'This is a binary file and cannot be shown as text.';
    case 'conflict':
      return 'The file changed on disk.';
    case 'invalid-path':
      return 'Invalid path.';
    case 'network':
      return 'No connection to the server.';
    case 'server':
      return 'Server error.';
  }
}
