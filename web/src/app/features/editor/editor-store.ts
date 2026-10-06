import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import { FileApiError, FilesApi, fileErrorMessage } from '../../core/api/files-api';
import { GitApi } from '../../core/api/git-api';
import { baseName } from '../../core/api/project-path';
import { ProjectContext } from '../../core/project/project-context';

/**
 * State of the files open in the editor: tabs, active file, content, unsaved changes, saving and conflicts.
 *
 * Does not depend on Monaco (thanks to this it can be tested). The CodeEditor component holds the Monaco models
 * and passes every content change here through `updateValue`. When the store replaces the content itself
 * (e.g. "Load from disk"), it increments `revision`, and CodeEditor copies it into the model.
 *
 * Provided at the Workspace component level, so it disappears together with it (and on logout,
 * because that is a full page reload).
 */

export interface OpenDocument {
  path: string;
  name: string;
  status: 'loading' | 'ready' | 'error';
  /** Current content in the editor. */
  value: string;
  /** Content last loaded from disk or saved. */
  savedValue: string;
  /** File version on disk corresponding to `savedValue`. */
  version: string;
  /** Incremented when the content is replaced by the store, not by the user. */
  revision: number;
  saving: boolean;
  /** Open error (status `error`) or error of the last save. */
  error: string | null;
  /** Set when a save was rejected because the file changed on disk. */
  conflict: { currentVersion: string | null } | null;
  /** The file changed on disk (console, pull) and the editor has unsaved changes (so we did not load it ourselves). */
  changedOnDisk: boolean;
  /** Diff view against the last commit (HEAD). `null` = regular editor. */
  diff: DiffState | null;
}

export type DiffState =
  | { status: 'loading' }
  | { status: 'ready'; original: string; isNew: boolean }
  | { status: 'error'; error: string };

export interface CursorPosition {
  line: number;
  column: number;
}

/** The shown file's indentation: spaces of `size`, or tabs `size` wide. */
export interface Indentation {
  insertSpaces: boolean;
  size: number;
}

/** Where a search result points: a line and the match's columns on it (1-based UTF-16 columns, as Monaco counts). */
export interface RevealTarget {
  line: number;
  column: number;
  endColumn: number;
}

/** A place `open(path, at)` asked to show; `seq` tells two requests for the same place apart. */
export interface RevealRequest extends RevealTarget {
  path: string;
  seq: number;
}

@Injectable()
export class EditorStore {
  private readonly files = inject(FilesApi);
  private readonly git = inject(GitApi);

  private readonly docs = signal<readonly OpenDocument[]>([]);
  private readonly activePathSignal = signal<string | null>(null);

  readonly documents = this.docs.asReadonly();
  readonly activePath = this.activePathSignal.asReadonly();
  readonly active = computed(() => this.docs().find((d) => d.path === this.activePathSignal()) ?? null);
  readonly unsavedCount = computed(() => this.docs().filter(isDirty).length);

  /** Set by CodeEditor for the shown file, shown in the status bar; the language by its display name ("C"). */
  readonly cursor = signal<CursorPosition | null>(null);
  readonly language = signal<string | null>(null);
  readonly indentation = signal<Indentation | null>(null);
  readonly eol = signal<'LF' | 'CRLF' | null>(null);
  /** Set by `open(path, at)`; CodeEditor selects and centres it once the file is shown. */
  readonly reveal = signal<RevealRequest | null>(null);
  private revealSeq = 0;

  private readonly project = inject(ProjectContext, { optional: true });

  constructor() {
    this.project?.filesChanged
      .pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((paths) => this.onExternalChange(paths));
  }

  /**
   * Files changed outside the editor (console, pull). Clean files are reloaded right away,
   * and with unsaved changes we only mark the file, so that the user decides.
   */
  onExternalChange(paths: readonly string[]): void {
    for (const path of paths) {
      const doc = this.find(path);
      if (!doc || doc.status !== 'ready') {
        continue;
      }
      if (doc.diff) {
        // A change from the console could have been a commit, so the version from HEAD could have changed too.
        void this.loadOriginal(path);
      }
      if (isDirty(doc) || doc.saving) {
        this.patch(path, (d) => ({ ...d, changedOnDisk: true }));
      } else {
        void this.reload(path);
      }
    }
  }

  /** Whether the file lies in a repository (workspace/repo/...), so its changes can be shown. */
  canDiff(path: string): boolean {
    return repoOf(path) !== null;
  }

  /** Turns the diff view against HEAD on or off for a file. */
  async toggleDiff(path: string): Promise<void> {
    const doc = this.find(path);
    if (!doc || doc.status !== 'ready') {
      return;
    }
    if (doc.diff) {
      this.patch(path, (d) => ({ ...d, diff: null }));
      return;
    }
    await this.loadOriginal(path);
  }

  private async loadOriginal(path: string): Promise<void> {
    const repo = repoOf(path);
    if (!repo) {
      return;
    }
    this.patch(path, (d) => ({ ...d, diff: d.diff?.status === 'ready' ? d.diff : { status: 'loading' } }));
    try {
      const original = await firstValueFrom(this.git.show(repo, path));
      this.patch(path, (d) => (d.diff ? { ...d, diff: { status: 'ready', original: original ?? '', isNew: original === null } } : d));
    } catch {
      this.patch(path, (d) => (d.diff ? { ...d, diff: { status: 'error', error: 'Could not load the version from the last commit.' } } : d));
    }
  }

  /** The user keeps their version despite the change on disk (saving will detect the conflict anyway). */
  keepLocalVersion(path: string): void {
    this.patch(path, (d) => ({ ...d, changedOnDisk: false }));
  }

  isDirty(path: string): boolean {
    const doc = this.find(path);
    return doc ? isDirty(doc) : false;
  }

  /** Opens a file and makes it active; `at` also selects a place in it once it is shown (a search result). */
  async open(path: string, at?: RevealTarget): Promise<void> {
    if (at) {
      this.reveal.set({ path, ...at, seq: ++this.revealSeq });
    }
    this.activePathSignal.set(path);
    const existing = this.find(path);
    if (existing && existing.status !== 'error') {
      return;
    }
    const placeholder: OpenDocument = {
      path,
      name: baseName(path),
      status: 'loading',
      value: '',
      savedValue: '',
      version: '',
      revision: 0,
      saving: false,
      error: null,
      conflict: null,
      changedOnDisk: false,
      diff: null
    };
    this.docs.update((docs) => (existing ? docs.map((d) => (d.path === path ? placeholder : d)) : [...docs, placeholder]));

    try {
      const file = await firstValueFrom(this.files.read(path));
      this.patch(path, (d) => ({
        ...d,
        status: 'ready',
        value: file.content,
        savedValue: file.content,
        version: file.version,
        revision: d.revision + 1
      }));
    } catch (error) {
      this.patch(path, (d) => ({ ...d, status: 'error', error: messageOf(error) }));
    }
  }

  activate(path: string): void {
    if (this.find(path)) {
      this.activePathSignal.set(path);
    }
  }

  /** Called by CodeEditor on every change in the editor. */
  updateValue(path: string, value: string): void {
    this.patch(path, (d) => (d.status === 'ready' && d.value !== value ? { ...d, value } : d));
  }

  /**
   * Closes a tab. With unsaved changes it closes only with `force`
   * (the component asks the user first). Returns whether it was closed.
   */
  close(path: string, force = false): boolean {
    const doc = this.find(path);
    if (!doc) {
      return true;
    }
    if (isDirty(doc) && !force) {
      return false;
    }
    const docs = this.docs();
    const index = docs.indexOf(doc);
    const remaining = docs.filter((d) => d !== doc);
    this.docs.set(remaining);
    if (this.activePathSignal() === path) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      this.activePathSignal.set(next?.path ?? null);
      if (!next) {
        this.cursor.set(null);
        this.language.set(null);
        this.indentation.set(null);
        this.eol.set(null);
      }
    }
    return true;
  }

  async save(path = this.activePathSignal()): Promise<void> {
    const doc = path ? this.find(path) : undefined;
    if (!doc || doc.status !== 'ready' || doc.saving || doc.conflict || !isDirty(doc)) {
      return;
    }
    await this.write(doc, doc.version);
  }

  /** Conflict: saves the content from the editor, overwriting the changes on disk. */
  async overwrite(path: string): Promise<void> {
    const doc = this.find(path);
    if (!doc?.conflict || doc.saving) {
      return;
    }
    const base = doc.conflict.currentVersion;
    if (base === null) {
      // The server did not provide the current version: without it we cannot safely overwrite, so we reload.
      await this.reload(path);
      return;
    }
    await this.write(doc, base);
  }

  /** Conflict or manual refresh: discards the changes from the editor and loads the file from disk. */
  async reload(path: string): Promise<void> {
    const doc = this.find(path);
    if (!doc || doc.saving) {
      return;
    }
    this.patch(path, (d) => ({ ...d, saving: true }));
    try {
      const file = await firstValueFrom(this.files.read(path));
      this.patch(path, (d) => ({
        ...d,
        status: 'ready',
        value: file.content,
        savedValue: file.content,
        version: file.version,
        revision: d.revision + 1,
        saving: false,
        error: null,
        conflict: null,
        changedOnDisk: false
      }));
    } catch (error) {
      this.patch(path, (d) => ({ ...d, saving: false, error: messageOf(error) }));
    }
  }

  private async write(doc: OpenDocument, baseVersion: string): Promise<void> {
    const sent = doc.value;
    this.patch(doc.path, (d) => ({ ...d, saving: true, error: null }));
    try {
      const { version } = await firstValueFrom(this.files.write(doc.path, sent, baseVersion));
      // The content could have changed during the save. We treat as saved only the content that went to the server.
      this.patch(doc.path, (d) => ({ ...d, savedValue: sent, version, saving: false, conflict: null }));
      this.project?.announceFilesSaved([doc.path]);
    } catch (error) {
      if (error instanceof FileApiError && error.kind === 'conflict') {
        this.patch(doc.path, (d) => ({
          ...d,
          saving: false,
          conflict: { currentVersion: error.currentVersion ?? null }
        }));
      } else {
        this.patch(doc.path, (d) => ({ ...d, saving: false, error: `Not saved. ${messageOf(error)}` }));
      }
    }
  }

  private find(path: string): OpenDocument | undefined {
    return this.docs().find((d) => d.path === path);
  }

  private patch(path: string, change: (doc: OpenDocument) => OpenDocument): void {
    this.docs.update((docs) => docs.map((d) => (d.path === path ? change(d) : d)));
  }
}

/** Repository of a file: the first two path segments (`workspace/repo`), if the file lies deeper. */
function repoOf(path: string): string | null {
  const parts = path.split('/');
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
}

function isDirty(doc: OpenDocument): boolean {
  return doc.status === 'ready' && doc.value !== doc.savedValue;
}

function messageOf(error: unknown): string {
  return fileErrorMessage(error instanceof FileApiError ? error.kind : 'server');
}
