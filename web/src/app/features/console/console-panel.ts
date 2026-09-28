import { Component, ElementRef, afterRenderEffect, inject, output, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ProjectContext } from '../../core/project/project-context';
import { ConsoleEffort, ConsoleMode, ConsoleModel, PermissionDecision, StepKind } from '../../core/realtime/console-protocol';
import { ConsoleStep, ConsoleStore } from './console-store';

/**
 * The "Konsola" (console) panel (right column): the conversation with Claude Code as plain monospace text,
 * without icons, colors or animations (a requirement from the mockup). Prompt field with model, effort and mode selection.
 * State and communication: ConsoleStore.
 */
@Component({
  selector: 'app-console-panel',
  imports: [FormsModule],
  templateUrl: './console-panel.html',
  styleUrl: './console-panel.scss'
})
export class ConsolePanel {
  protected readonly store = inject(ConsoleStore);
  protected readonly project = inject(ProjectContext);
  readonly collapse = output<void>();

  private readonly log = viewChild.required<ElementRef<HTMLElement>>('log');
  /** We read and clear the prompt field directly: sending right after pasting text clears it too. */
  private readonly input = viewChild.required<ElementRef<HTMLTextAreaElement>>('input');
  private stickToBottom = true;

  protected readonly models: { value: ConsoleModel; label: string }[] = [
    { value: 'opus', label: 'opus-5.5' },
    { value: 'sonnet', label: 'sonnet-5' },
    { value: 'haiku', label: 'haiku-4.5' }
  ];
  protected readonly efforts: { value: ConsoleEffort; label: string }[] = [
    { value: 'low', label: 'niski' },
    { value: 'medium', label: 'średni' },
    { value: 'high', label: 'wysoki' },
    { value: 'max', label: 'maks' }
  ];
  protected readonly modes: { value: ConsoleMode; label: string }[] = [
    { value: 'default', label: 'pytaj przed edycją' },
    { value: 'acceptEdits', label: 'akceptuj edycje' },
    { value: 'plan', label: 'plan' }
  ];

  constructor() {
    // Scrolling to the bottom on new entries, unless the user scrolled up to read something.
    afterRenderEffect(() => {
      this.store.entries();
      const log = this.log().nativeElement;
      if (this.stickToBottom) {
        log.scrollTop = log.scrollHeight;
      }
    });
  }

  protected onScroll(): void {
    const log = this.log().nativeElement;
    this.stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  }

  protected setModel(value: ConsoleModel): void {
    this.store.options.update((o) => ({ ...o, model: value }));
  }

  protected setEffort(value: ConsoleEffort): void {
    this.store.options.update((o) => ({ ...o, effort: value }));
  }

  protected setMode(value: ConsoleMode): void {
    this.store.options.update((o) => ({ ...o, mode: value }));
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void this.store.interrupt();
    }
  }

  protected async submit(): Promise<void> {
    const input = this.input().nativeElement;
    const text = input.value;
    this.stickToBottom = true;
    if ((await this.store.send(text)) && input.value === text) {
      input.value = '';
    }
  }

  protected answer(requestId: string, decision: PermissionDecision): void {
    void this.store.answer(requestId, decision);
  }

  protected verb(kind: StepKind): string {
    return VERBS[kind].padEnd(VERB_WIDTH);
  }

  protected stats(step: ConsoleStep): string {
    const parts: string[] = [];
    if (step.added) {
      parts.push(`+${step.added}`);
    }
    if (step.removed) {
      parts.push(`−${step.removed}`);
    }
    return parts.length ? `  ${parts.join(' ')}` : '';
  }

  protected time(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  }

  protected decisionLabel(decision: PermissionDecision): string {
    return DECISIONS[decision];
  }
}

/** Verbs are padded with spaces to equal width, so that paths line up in a column like in a terminal. */
const VERB_WIDTH = 13;
const VERBS: Record<StepKind, string> = {
  read: 'przeczytano',
  edit: 'edycja',
  write: 'utworzono',
  command: 'uruchomiono',
  search: 'wyszukano',
  other: 'krok'
};

const DECISIONS: Record<PermissionDecision, string> = {
  allow: 'zezwolono',
  'allow-always': 'zezwolono na stałe',
  deny: 'odmówiono'
};
