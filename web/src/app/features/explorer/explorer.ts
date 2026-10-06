import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import { DirectoryEntry, FileApiError, FilesApi, fileErrorMessage } from '../../core/api/files-api';
import { fileIconUrl, folderIconUrl } from '../../core/icons/file-icons';
import { ProjectContext } from '../../core/project/project-context';

type DirectoryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: readonly DirectoryEntry[] }
  | { status: 'error'; message: string };

export type ExplorerRow =
  | { kind: 'entry'; entry: DirectoryEntry; depth: number; expanded: boolean }
  | { kind: 'status'; text: string; depth: number; error: boolean };

/**
 * File tree. Directories are loaded lazily, only when expanded,
 * so large repositories (e.g. with node_modules) do not slow down the start.
 * Clicking a file emits `openFile` with its path. When the console changes files (ProjectContext.filesChanged),
 * the tree refreshes itself.
 */
@Component({
  selector: 'app-explorer',
  templateUrl: './explorer.html',
  styleUrl: './explorer.scss'
})
export class Explorer {
  private readonly files = inject(FilesApi);

  /** Directory shown as the tree root (relative path, '' = the whole projects directory). */
  readonly root = input('');
  readonly activePath = input<string | null>(null);
  /** Badges from the git status: path → letter (M, U, …) or `•` for a directory with changes. */
  readonly decorations = input<ReadonlyMap<string, string>>(new Map());
  readonly openFile = output<string>();
  /** The user clicked "Refresh" (e.g. to also refresh the git status). */
  readonly refreshed = output<void>();

  private readonly directories = signal<ReadonlyMap<string, DirectoryState>>(new Map());
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly rows = computed(() => {
    const rows: ExplorerRow[] = [];
    this.appendRows(rows, this.root(), 0);
    return rows;
  });

  constructor() {
    effect(() => {
      const root = this.root();
      untracked(() => {
        this.directories.set(new Map());
        this.expanded.set(new Set());
        void this.load(root);
      });
    });

    inject(ProjectContext, { optional: true })
      ?.filesChanged.pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => this.refresh());
  }

  protected select(row: Extract<ExplorerRow, { kind: 'entry' }>): void {
    if (row.entry.kind === 'file') {
      this.openFile.emit(row.entry.path);
      return;
    }
    const path = row.entry.path;
    const next = new Set(this.expanded());
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (this.directories().get(path)?.status !== 'ready') {
        void this.load(path);
      }
    }
    this.expanded.set(next);
  }

  protected markLabel(mark: string): string {
    return MARK_LABELS[mark] ?? mark;
  }

  /** The theme's icon of a row; an expanded folder has its open variant. */
  protected icon(row: Extract<ExplorerRow, { kind: 'entry' }>): string {
    return row.entry.kind === 'directory' ? folderIconUrl(row.entry.name, row.expanded) : fileIconUrl(row.entry.name);
  }

  /** Reloads the root and all expanded directories (e.g. after changes made by the console). */
  protected refreshClicked(): void {
    this.refresh();
    this.refreshed.emit();
  }

  private refresh(): void {
    void this.load(this.root());
    for (const path of this.expanded()) {
      void this.load(path);
    }
  }

  private async load(path: string): Promise<void> {
    this.setDirectory(path, { status: 'loading' });
    try {
      const entries = await firstValueFrom(this.files.list(path));
      this.setDirectory(path, { status: 'ready', entries: [...entries].sort(compareEntries) });
    } catch (error) {
      const kind = error instanceof FileApiError ? error.kind : 'server';
      this.setDirectory(path, { status: 'error', message: fileErrorMessage(kind) });
    }
  }

  private setDirectory(path: string, state: DirectoryState): void {
    this.directories.update((map) => new Map(map).set(path, state));
  }

  private appendRows(rows: ExplorerRow[], path: string, depth: number): void {
    const state = this.directories().get(path);
    if (!state || state.status === 'loading') {
      rows.push({ kind: 'status', text: 'Loading…', depth, error: false });
      return;
    }
    if (state.status === 'error') {
      rows.push({ kind: 'status', text: state.message, depth, error: true });
      return;
    }
    if (state.entries.length === 0) {
      rows.push({ kind: 'status', text: 'Empty directory', depth, error: false });
      return;
    }
    const expanded = this.expanded();
    for (const entry of state.entries) {
      const isOpen = entry.kind === 'directory' && expanded.has(entry.path);
      rows.push({ kind: 'entry', entry, depth, expanded: isOpen });
      if (isOpen) {
        this.appendRows(rows, entry.path, depth + 1);
      }
    }
  }
}

const MARK_LABELS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  U: 'untracked',
  '!': 'conflict',
  '•': 'contains changes'
};

// File names sort the owner's way (ł after l): a choice apart from the interface's language.
const collator = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });

/** Directories before files, alphabetically within a group (with numbers in natural order). */
function compareEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === 'directory' ? -1 : 1;
  }
  return collator.compare(a.name, b.name);
}
