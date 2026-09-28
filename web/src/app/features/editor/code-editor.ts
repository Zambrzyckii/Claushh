import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import type * as MonacoApi from 'monaco-editor';

import { EditorStore, OpenDocument } from './editor-store';
import { MONACO_THEME, Monaco, loadMonaco } from './monaco-loader';

interface ModelEntry {
  model: MonacoApi.editor.ITextModel;
  revision: number;
  viewState: MonacoApi.editor.ICodeEditorViewState | null;
}

/**
 * A single Monaco instance showing the active file from EditorStore.
 *
 * Each open file has its own Monaco model (its own undo history, cursor position, scroll).
 * Changes from the editor go to the store through `updateValue`. Changes from the store (higher `revision`)
 * are copied into the model. Models of closed files are removed from memory right away.
 */
@Component({
  selector: 'app-code-editor',
  template: `
    <div #host class="host"></div>
    @if (loadFailed()) {
      <p class="failed" role="alert">Nie udało się załadować edytora. Odśwież stronę.</p>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      height: 100%;
    }
    .host {
      position: absolute;
      inset: 0;
    }
    .failed {
      position: absolute;
      margin: 16px;
      color: var(--accent);
    }
  `
})
export class CodeEditor {
  private readonly store = inject(EditorStore);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  private monaco: Monaco | null = null;
  private editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
  private readonly models = new Map<string, ModelEntry>();
  private shownPath: string | null = null;
  private destroyed = false;

  private readonly ready = signal(false);
  protected readonly loadFailed = signal(false);

  constructor() {
    afterNextRender(() => void this.init());

    effect(() => {
      if (!this.ready()) {
        return;
      }
      const docs = this.store.documents();
      const active = this.store.active();
      untracked(() => this.sync(docs, active));
    });

    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.editor?.dispose();
      for (const entry of this.models.values()) {
        entry.model.dispose();
      }
      this.models.clear();
    });
  }

  private async init(): Promise<void> {
    let monaco: Monaco;
    try {
      monaco = await loadMonaco();
    } catch {
      this.loadFailed.set(true);
      return;
    }
    if (this.destroyed) {
      return;
    }
    this.monaco = monaco;
    this.editor = monaco.editor.create(this.host().nativeElement, {
      model: null,
      theme: MONACO_THEME,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      padding: { top: 8 }
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.store.save());
    this.editor.onDidChangeCursorPosition((e) =>
      this.store.cursor.set({ line: e.position.lineNumber, column: e.position.column })
    );
    this.ready.set(true);
  }

  private sync(docs: readonly OpenDocument[], active: OpenDocument | null): void {
    const monaco = this.monaco;
    const editor = this.editor;
    if (!monaco || !editor) {
      return;
    }

    const open = new Set(docs.map((d) => d.path));
    for (const [path, entry] of this.models) {
      if (!open.has(path)) {
        entry.model.dispose();
        this.models.delete(path);
      }
    }

    for (const doc of docs) {
      if (doc.status !== 'ready') {
        continue;
      }
      const entry = this.models.get(doc.path);
      if (!entry) {
        const uri = monaco.Uri.from({ scheme: 'file', path: `/${doc.path}` });
        const model = monaco.editor.createModel(doc.value, undefined, uri);
        const path = doc.path;
        model.onDidChangeContent(() => this.store.updateValue(path, model.getValue()));
        this.models.set(path, { model, revision: doc.revision, viewState: null });
      } else if (entry.revision !== doc.revision) {
        entry.revision = doc.revision;
        if (entry.model.getValue() !== doc.value) {
          entry.model.setValue(doc.value);
        }
      }
    }

    const target = active?.status === 'ready' ? (this.models.get(active.path) ?? null) : null;
    const targetPath = target ? active!.path : null;
    if (targetPath === this.shownPath) {
      return;
    }

    const previous = this.shownPath ? this.models.get(this.shownPath) : undefined;
    if (previous) {
      previous.viewState = editor.saveViewState();
    }
    editor.setModel(target?.model ?? null);
    this.shownPath = targetPath;

    if (target) {
      if (target.viewState) {
        editor.restoreViewState(target.viewState);
      }
      const position = editor.getPosition();
      this.store.cursor.set(position ? { line: position.lineNumber, column: position.column } : null);
      this.store.language.set(target.model.getLanguageId());
      editor.focus();
    } else {
      this.store.cursor.set(null);
      this.store.language.set(null);
    }
  }
}
