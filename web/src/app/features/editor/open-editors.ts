import { Component, inject, model, output } from '@angular/core';

import { fileIconFor } from '../../core/icons/file-icons';
import { EditorStore, OpenDocument } from './editor-store';

/**
 * OPEN EDITORS at the top of the Explorer view (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the open files with their
 * icon and directory, a dot for unsaved changes (the close button on hover) and the active one marked. Collapsed at
 * start, as in VS Code; at most nine rows, then it scrolls. Closing asks the tab's question.
 */
@Component({
  selector: 'app-open-editors',
  templateUrl: './open-editors.html',
  styleUrl: './open-editors.scss'
})
export class OpenEditors {
  protected readonly store = inject(EditorStore);
  /** Whether the rows are shown. The parent owns the value and binds it two ways. */
  readonly expanded = model(false);
  /** A row was clicked and its file is now the active one. */
  readonly opened = output<void>();

  protected readonly icon = fileIconFor;

  protected directory(doc: OpenDocument): string {
    return doc.path.slice(0, Math.max(0, doc.path.length - doc.name.length - 1));
  }

  protected activate(doc: OpenDocument): void {
    this.store.activate(doc.path);
    this.opened.emit();
  }

  protected close(doc: OpenDocument): void {
    this.store.closeWithQuestion(doc.path);
  }
}
