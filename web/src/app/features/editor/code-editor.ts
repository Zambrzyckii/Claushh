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

import { isTypingElsewhere } from '../../core/browser/focus';
import { EditorStore, OpenDocument } from './editor-store';
import { MONACO_THEME, Monaco, loadMonaco } from './monaco-loader';

interface ModelEntry {
  model: MonacoApi.editor.ITextModel;
  revision: number;
  viewState: MonacoApi.editor.ICodeEditorViewState | null;
}

const EDITOR_OPTIONS: MonacoApi.editor.IEditorOptions & MonacoApi.editor.IGlobalEditorOptions = {
  theme: MONACO_THEME,
  automaticLayout: true,
  minimap: { enabled: false },
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  lineHeight: 20,
  scrollBeyondLastLine: false,
  padding: { top: 8 }
};

/**
 * Monaco showing the active file from EditorStore: a regular editor or a diff view against HEAD.
 *
 * Each open file has its own Monaco model (its own undo history, cursor position, scroll).
 * Changes from the editor go to the store through `updateValue`. Changes from the store (higher `revision`)
 * are copied into the model. Models of closed files are removed from memory right away.
 *
 * Diff view: on the left the version from HEAD (a separate read-only model), on the right the same model as
 * in the regular editor, so editing and Ctrl+S work the same way. A narrow screen switches the diff to a single-column view.
 */
@Component({
  selector: 'app-code-editor',
  template: `
    <div #host class="host" [class.hidden]="showDiff()"></div>
    <div #diffHost class="host" [class.hidden]="!showDiff()"></div>
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
    .hidden {
      display: none;
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
  private readonly element: HTMLElement = inject(ElementRef).nativeElement;
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly diffHost = viewChild.required<ElementRef<HTMLElement>>('diffHost');

  private monaco: Monaco | null = null;
  private editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
  private diffEditor: MonacoApi.editor.IStandaloneDiffEditor | null = null;
  private readonly models = new Map<string, ModelEntry>();
  /** Versions from HEAD for files with the diff view turned on. */
  private readonly originals = new Map<string, MonacoApi.editor.ITextModel>();
  /** What is shown now: `path|plain` or `path|diff`. */
  private shownKey: string | null = null;
  private shownPath: string | null = null;
  private destroyed = false;

  private readonly ready = signal(false);
  protected readonly showDiff = signal(false);
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
      this.diffEditor?.dispose();
      this.editor?.dispose();
      for (const entry of this.models.values()) {
        entry.model.dispose();
      }
      for (const model of this.originals.values()) {
        model.dispose();
      }
      this.models.clear();
      this.originals.clear();
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
    this.editor = monaco.editor.create(this.host().nativeElement, { ...EDITOR_OPTIONS, model: null });
    this.wire(this.editor);
    this.ready.set(true);
  }

  /** Ctrl+S and cursor position for the editor (the regular one or the right side of the diff view). */
  private wire(editor: MonacoApi.editor.IStandaloneCodeEditor): void {
    const monaco = this.monaco!;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.store.save());
    editor.onDidChangeCursorPosition((e) =>
      this.store.cursor.set({ line: e.position.lineNumber, column: e.position.column })
    );
  }

  private sync(docs: readonly OpenDocument[], active: OpenDocument | null): void {
    const monaco = this.monaco;
    const editor = this.editor;
    if (!monaco || !editor) {
      return;
    }

    this.syncModels(monaco, docs);
    this.syncOriginals(monaco, docs);

    const target = active?.status === 'ready' ? (this.models.get(active.path) ?? null) : null;
    const targetPath = target ? active!.path : null;
    const diffOriginal = target && active?.diff?.status === 'ready' ? this.originals.get(active.path) : undefined;
    const key = targetPath === null ? null : `${targetPath}|${diffOriginal ? 'diff' : 'plain'}`;
    if (key === this.shownKey) {
      return;
    }

    // Remember the position in the file that stops being visible in the regular editor.
    const previous = this.shownPath ? this.models.get(this.shownPath) : undefined;
    if (previous && this.shownKey?.endsWith('|plain')) {
      previous.viewState = editor.saveViewState();
    }
    this.shownKey = key;
    this.shownPath = targetPath;

    if (target && diffOriginal) {
      editor.setModel(null);
      const diff = this.ensureDiffEditor(monaco);
      diff.setModel({ original: diffOriginal, modified: target.model });
      this.showDiff.set(true);
      this.reportPosition(diff.getModifiedEditor(), target.model);
      this.focus(diff.getModifiedEditor());
      return;
    }

    this.diffEditor?.setModel(null);
    this.showDiff.set(false);
    editor.setModel(target?.model ?? null);
    if (target) {
      if (target.viewState) {
        editor.restoreViewState(target.viewState);
      }
      this.reportPosition(editor, target.model);
      this.focus(editor);
    } else {
      this.store.cursor.set(null);
      this.store.language.set(null);
    }
  }

  private syncModels(monaco: Monaco, docs: readonly OpenDocument[]): void {
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
  }

  private syncOriginals(monaco: Monaco, docs: readonly OpenDocument[]): void {
    const wanted = new Map(
      docs.flatMap((d) => (d.status === 'ready' && d.diff?.status === 'ready' ? [[d.path, d.diff.original] as const] : []))
    );
    for (const [path, model] of this.originals) {
      if (!wanted.has(path)) {
        if (this.diffEditor?.getModel()?.original === model) {
          this.diffEditor.setModel(null);
          this.shownKey = null;
        }
        model.dispose();
        this.originals.delete(path);
      }
    }
    for (const [path, original] of wanted) {
      const existing = this.originals.get(path);
      if (!existing) {
        // A scheme other than `file:`, so as not to collide with the file model. The language follows from the extension.
        const uri = monaco.Uri.from({ scheme: 'git-head', path: `/${path}` });
        this.originals.set(path, monaco.editor.createModel(original, undefined, uri));
      } else if (existing.getValue() !== original) {
        existing.setValue(original);
      }
    }
  }

  private ensureDiffEditor(monaco: Monaco): MonacoApi.editor.IStandaloneDiffEditor {
    if (!this.diffEditor) {
      this.diffEditor = monaco.editor.createDiffEditor(this.diffHost().nativeElement, {
        ...EDITOR_OPTIONS,
        originalEditable: false,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true
      });
      this.wire(this.diffEditor.getModifiedEditor());
    }
    return this.diffEditor;
  }

  /**
   * Focus to the editor after showing a file, but not when the user is typing somewhere else at that time
   * (e.g. in the console or a terminal): the file loads asynchronously and focus would jump while typing.
   */
  private focus(editor: MonacoApi.editor.ICodeEditor): void {
    if (!isTypingElsewhere(this.element)) {
      editor.focus();
    }
  }

  private reportPosition(editor: MonacoApi.editor.ICodeEditor, model: MonacoApi.editor.ITextModel): void {
    const position = editor.getPosition();
    this.store.cursor.set(position ? { line: position.lineNumber, column: position.column } : null);
    this.store.language.set(model.getLanguageId());
  }
}
