import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

import { toApiError } from './api-error';

/**
 * Search in files (`POST /api/search`). Contract: docs/ARCHITECTURE.md, "Files and editor" → "Search API contract". A
 * POST, so the searched text never appears in a URL. Errors are ApiError (`invalid` for a 400).
 */

export interface SearchRequest {
  /** The search root, relative to the projects directory ('' = all of it). */
  path: string;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
}

export interface SearchMatch {
  line: number;
  /** 1-based UTF-16 column of the line's first match. */
  column: number;
  preview: string;
  /** The matches as [start, end) offsets inside `preview`. */
  ranges: [number, number][];
}

export interface SearchFile {
  /** Relative to the projects directory. */
  path: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: SearchFile[];
  matchCount: number;
  limit: 'results' | 'time' | null;
}

@Injectable({ providedIn: 'root' })
export class SearchApi {
  private readonly http = inject(HttpClient);

  search(request: SearchRequest): Observable<SearchResult> {
    return this.http.post<SearchResult>('/api/search', request).pipe(
      map((r) => ({
        files: r.files ?? [],
        matchCount: r.matchCount ?? 0,
        limit: r.limit === 'results' || r.limit === 'time' ? r.limit : null
      })),
      catchError((error: unknown) => throwError(() => toApiError(error)))
    );
  }
}
