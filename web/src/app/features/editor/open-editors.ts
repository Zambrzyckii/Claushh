import { Component, inject } from '@angular/core';

import { Dialogs } from '../../core/browser/dialogs';
import { fileIconUrl } from '../../core/icons/file-icons';
import { WorkbenchState } from '../workspace/workbench-state';
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
  protected readonly state = inject(WorkbenchState);
  private readonly dialogs = inject(Dialogs);

  protected dirty(doc: OpenDocument): boolean {
    return doc.status === 'ready' && doc.value !== doc.savedValue;
  }

  protected icon(doc: OpenDocument): string {
    return fileIconUrl(doc.name);
  }

  protected directory(doc: OpenDocument): string {
    return doc.path.slice(0, Math.max(0, doc.path.length - doc.name.length - 1));
  }

  protected activate(doc: OpenDocument): void {
    this.store.activate(doc.path);
    this.state.drawerOpen.set(false);
  }

  protected close(doc: OpenDocument): void {
    if (this.store.close(doc.path)) {
      return;
    }
    if (this.dialogs.confirm(`${doc.name} has unsaved changes. Close it without saving?`)) {
      this.store.close(doc.path, true);
    }
  }
}
