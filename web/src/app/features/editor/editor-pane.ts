import { Component, computed, inject } from '@angular/core';

import { Dialogs } from '../../core/browser/dialogs';
import { CodeEditor } from './code-editor';
import { EditorStore, OpenDocument } from './editor-store';

/**
 * Middle part of the view: tabs of open files, path, messages (error, conflict) and the editor itself.
 * The state is held by EditorStore, this component only shows it and passes on user actions.
 */
@Component({
  selector: 'app-editor-pane',
  imports: [CodeEditor],
  templateUrl: './editor-pane.html',
  styleUrl: './editor-pane.scss'
})
export class EditorPane {
  protected readonly store = inject(EditorStore);
  private readonly dialogs = inject(Dialogs);

  protected readonly breadcrumb = computed(() => this.store.active()?.path.split('/') ?? []);

  protected dirty(doc: OpenDocument): boolean {
    return doc.status === 'ready' && doc.value !== doc.savedValue;
  }

  /** Diff view for a file that is not in the last commit. */
  protected isNewFile(doc: OpenDocument): boolean {
    return doc.diff?.status === 'ready' && doc.diff.isNew;
  }

  protected close(doc: OpenDocument, event?: Event): void {
    event?.stopPropagation();
    if (this.store.close(doc.path)) {
      return;
    }
    if (this.dialogs.confirm(`${doc.name} has unsaved changes. Close it without saving?`)) {
      this.store.close(doc.path, true);
    }
  }

  protected closeWithMiddleClick(doc: OpenDocument, event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.close(doc);
    }
  }

  protected overwrite(doc: OpenDocument): void {
    void this.store.overwrite(doc.path);
  }

  protected reload(doc: OpenDocument): void {
    if (this.dirty(doc) && !doc.conflict) {
      if (!this.dialogs.confirm(`Discard the unsaved changes in ${doc.name} and load the file from disk?`)) {
        return;
      }
    }
    void this.store.reload(doc.path);
  }

  protected retry(doc: OpenDocument): void {
    void this.store.open(doc.path);
  }
}
