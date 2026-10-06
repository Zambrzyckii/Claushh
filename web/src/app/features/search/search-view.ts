import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { baseName } from '../../core/api/project-path';
import { SearchFile, SearchMatch, SearchResult } from '../../core/api/search-api';
import { fileIconUrl } from '../../core/icons/file-icons';
import { ProjectContext } from '../../core/project/project-context';
import { countLabel } from '../../core/text/format';
import { EditorStore } from '../editor/editor-store';
import { WorkbenchState } from '../workspace/workbench-state';
import { SearchOption, SearchStore } from './search-store';

/**
 * The Search view of the side bar (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the query with VS Code's three toggles,
 * the files to include and exclude behind "…", and the results by file. A preview is text with its matches in spans,
 * never HTML. A click opens the file at the match and closes the phone's drawer. The view's header (Refresh, Clear,
 * Collapse All) belongs to SideBar.
 */
@Component({
  selector: 'app-search-view',
  imports: [FormsModule],
  templateUrl: './search-view.html',
  styleUrl: './search-view.scss'
})
export class SearchView {
  protected readonly store = inject(SearchStore);
  private readonly editor = inject(EditorStore);
  private readonly state = inject(WorkbenchState);
  private readonly project = inject(ProjectContext);
  private readonly injector = inject(Injector);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  /** The last focus request this view has seen; a view created later ignores the older ones. */
  private focusSeen = this.state.searchFocus();

  protected readonly toggles: readonly { option: SearchOption; label: string; icon: string }[] = [
    { option: 'matchCase', label: 'Match Case', icon: 'case-sensitive' },
    { option: 'wholeWord', label: 'Match Whole Word', icon: 'whole-word' },
    { option: 'regex', label: 'Use Regular Expression', icon: 'regex' }
  ];
  protected readonly error = computed(() => {
    const state = this.store.state();
    return state.status === 'error' ? state.message : '';
  });

  constructor() {
    // WorkbenchState.show('search') asks for the field: the activity bar and the phone's Search button.
    effect(() => {
      const request = this.state.searchFocus();
      if (request !== this.focusSeen) {
        this.focusSeen = request;
        afterNextRender(() => this.field().nativeElement.focus(), { injector: this.injector });
      }
    });
  }

  protected pressed(option: SearchOption): boolean {
    return this.store[option]();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.store.searchNow();
    }
  }

  protected summary(result: SearchResult): string {
    return `${countLabel(result.matchCount, 'result', 'results')} in ${countLabel(result.files.length, 'file', 'files')}`;
  }

  protected name(path: string): string {
    return baseName(path);
  }

  /** The file's directory below the searched repository (from the projects directory without one). */
  protected directory(path: string): string {
    const root = this.project.path();
    const inRoot = root !== '' && path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
    return inRoot.includes('/') ? inRoot.slice(0, inRoot.lastIndexOf('/')) : '';
  }

  protected icon(path: string): string {
    return fileIconUrl(baseName(path));
  }

  /** The file's badge: its highlighted matches, at least one per line. */
  protected count(file: SearchFile): number {
    return file.matches.reduce((sum, match) => sum + Math.max(1, match.ranges.length), 0);
  }

  /** The preview as text parts with the matches marked; a range out of order is ignored. */
  protected parts(match: SearchMatch): { text: string; hit: boolean }[] {
    const parts: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (const [start, end] of match.ranges) {
      if (start < at || end <= start) {
        continue;
      }
      if (start > at) {
        parts.push({ text: match.preview.slice(at, start), hit: false });
      }
      parts.push({ text: match.preview.slice(start, end), hit: true });
      at = end;
    }
    if (at < match.preview.length) {
      parts.push({ text: match.preview.slice(at), hit: false });
    }
    return parts;
  }

  protected open(path: string, match: SearchMatch): void {
    const [start, end] = match.ranges[0] ?? [0, 0];
    void this.editor.open(path, { line: match.line, column: match.column, endColumn: match.column + (end - start) });
    this.state.drawerOpen.set(false);
  }
}
