import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { baseName } from '../../core/api/project-path';
import { DeviceLayout } from '../../core/browser/device-layout';
import { Dialogs } from '../../core/browser/dialogs';
import { fileIconUrl } from '../../core/icons/file-icons';
import { ProjectContext } from '../../core/project/project-context';
import { ConsoleEffort, ConsoleMode, ConsoleModel, PermissionDecision, PromptFile, StepKind } from '../../core/realtime/console-protocol';
import { countLabel, formatTime } from '../../core/text/format';
import { revealHidden } from '../../core/text/visible-text';
import { ConsoleStore } from './console-store';

/**
 * The permission buttons ("yes", "yes, always") stay inactive for this many ms after a request appears. The request arrives
 * asynchronously and scrolls the log to the bottom, so without this a click meant for something else could land on them.
 */
export const PERMISSION_ARM_MS = 600;

/**
 * The Console panel, VS Code's secondary side bar (docs/ARCHITECTURE.md, "Console"): the conversation with Claude Code
 * as monospace text without icons or images (the step verbs, counts and notes in color), its chrome with codicons, and
 * the composer card: the prompt, the open file's chip, the mode chip, Send or Stop, and the model and effort chip. A chip is a native
 * <select> laid over its label, so a tap opens the platform's own picker. State and communication: ConsoleStore.
 *
 * Permission requests: the command with hidden characters made visible (`revealHidden`), permission buttons active only after
 * `PERMISSION_ARM_MS`, "yes, always" only with a known rule and after confirmation (docs/ARCHITECTURE.md, "Console").
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
  protected readonly layout = inject(DeviceLayout);
  private readonly dialogs = inject(Dialogs);
  private readonly injector = inject(Injector);
  readonly collapse = output<void>();

  /** Permission requests that can already be answered "yes" (`PERMISSION_ARM_MS` has passed). */
  protected readonly armed = signal<ReadonlySet<string>>(new Set());
  private readonly arming = new Set<string>();
  private readonly armTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Permission request to whose beginning the log has already been scrolled. */
  private scrolledToQuestion: string | null = null;
  private armedConversation: string | null = null;

  private readonly log = viewChild.required<ElementRef<HTMLElement>>('log');
  /** We read and clear the prompt field directly: sending right after pasting text clears it too. */
  private readonly input = viewChild.required<ElementRef<HTMLTextAreaElement>>('input');
  private readonly detachButton = viewChild<ElementRef<HTMLButtonElement>>('detachButton');
  private readonly attachButton = viewChild<ElementRef<HTMLButtonElement>>('attachButton');
  private stickToBottom = true;

  protected readonly models: { value: ConsoleModel; label: string }[] = [
    { value: 'opus', label: 'opus-5.5' },
    { value: 'sonnet', label: 'sonnet-5' },
    { value: 'haiku', label: 'haiku-4.5' }
  ];
  protected readonly efforts: { value: ConsoleEffort; label: string }[] = [
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
    { value: 'max', label: 'max' }
  ];
  protected readonly modes: { value: ConsoleMode; label: string }[] = [
    { value: 'default', label: 'ask before edits' },
    { value: 'acceptEdits', label: 'accept edits' },
    { value: 'plan', label: 'plan' }
  ];

  /** While the console works or waits for an answer, Stop takes the place of Send. */
  protected readonly busy = computed(() => this.store.state() === 'working' || this.store.state() === 'waiting');
  protected readonly modeLabel = computed(() => labelOf(this.modes, this.store.options().mode));
  protected readonly modeIcon = computed(() => MODE_ICONS[this.store.options().mode]);
  protected readonly modelLabel = computed(() => labelOf(this.models, this.store.options().model));
  protected readonly effortLabel = computed(() => labelOf(this.efforts, this.store.options().effort));

  constructor() {
    effect(() => {
      const conversation = this.store.conversation();
      const entries = this.store.entries();
      untracked(() => {
        // Request identifiers are unique within a conversation. In a new conversation everything counts from scratch, so that a repeated
        // identifier does not skip the button delay or the scroll to the beginning of the request.
        if (conversation !== this.armedConversation) {
          this.armedConversation = conversation;
          this.resetArming();
        }
        for (const entry of entries) {
          if (entry.kind === 'permission' && entry.decision === null && !this.arming.has(entry.requestId)) {
            this.arm(entry.requestId);
          }
        }
      });
    });
    inject(DestroyRef).onDestroy(() => {
      for (const timer of this.armTimers) {
        clearTimeout(timer);
      }
    });

    // Scrolling to the bottom on new entries, unless the user scrolled up to read something.
    // Exception: a permission request taller than the log is shown from its beginning, so that the command does not start outside the view.
    afterRenderEffect(() => {
      this.store.entries();
      const log = this.log().nativeElement;
      if (!this.stickToBottom) {
        return;
      }
      log.scrollTop = log.scrollHeight;
      const question = [...log.querySelectorAll<HTMLElement>('.permission')].at(-1);
      const id = question?.dataset['requestId'];
      if (question && id && id !== this.scrolledToQuestion && question.offsetHeight > log.clientHeight) {
        this.scrolledToQuestion = id;
        log.scrollTop += question.getBoundingClientRect().top - log.getBoundingClientRect().top - 8;
        this.stickToBottom = false;
      }
    });
  }

  /** Puts the focus in the prompt: Workspace calls it when Ctrl+Alt+B opens the console. */
  focusPrompt(): void {
    this.input().nativeElement.focus();
  }

  /** The file chip: the name and a selection's lines ("main.c:5-10"). */
  protected fileLabel(file: PromptFile): string {
    return baseName(file.path) + linesOf(file);
  }

  protected fileName(file: PromptFile): string {
    return baseName(file.path);
  }

  protected fileIcon(file: PromptFile): string {
    return fileIconUrl(baseName(file.path));
  }

  /** The line under a prompt that named a file: its path in the conversation's directory and the lines. */
  protected fileNote(file: PromptFile): string {
    return `⧉ ${file.path}${linesOf(file)}`;
  }

  /** × and "+ main.c" take each other's place, so the focus moves to the button that replaced the clicked one. */
  protected detachFile(): void {
    this.store.detachFile();
    afterNextRender(() => this.attachButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected attachFile(): void {
    this.store.attachFile();
    afterNextRender(() => this.detachButton()?.nativeElement.focus(), { injector: this.injector });
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

  /** Enter sends, Shift+Enter makes a new line; with a coarse pointer Enter makes a new line and Send sends. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !this.layout.touch()) {
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
    if (decision !== 'deny' && !this.armed().has(requestId)) {
      return;
    }
    void this.store.answer(requestId, decision);
  }

  /** "yes, always" saves a permanent rule, so it requires confirmation showing the rule. */
  protected answerAlways(requestId: string, rule: string): void {
    if (!this.armed().has(requestId)) {
      return;
    }
    if (
      this.dialogs.confirm(
        `Save a permanent permission: ${revealHidden(rule)}?\n\nThe console will stop asking about commands that match this rule. ` +
          'The server saves the rule for this project, not in a repository file.'
      )
    ) {
      void this.store.answer(requestId, 'allow-always');
    }
  }

  protected reveal(text: string): string {
    return revealHidden(text);
  }

  /**
   * Note under a long command (several lines or over 200 characters after `revealHidden`): the whole command is above
   * and has to be read before agreeing. `null` for a short command.
   */
  protected lengthNote(text: string): string | null {
    const shown = revealHidden(text);
    const lines = shown.split('\n').length;
    if (lines > 1) {
      return `The command has ${countLabel(lines, 'line', 'lines')}. Read all of it above.`;
    }
    return shown.length > 200 ? `The command has ${countLabel(shown.length, 'character', 'characters')}. Read all of it above.` : null;
  }

  private resetArming(): void {
    for (const timer of this.armTimers) {
      clearTimeout(timer);
    }
    this.armTimers.clear();
    this.arming.clear();
    this.armed.set(new Set());
    this.scrolledToQuestion = null;
  }

  private arm(requestId: string): void {
    this.arming.add(requestId);
    const timer = setTimeout(() => {
      this.armTimers.delete(timer);
      this.armed.update((ids) => new Set(ids).add(requestId));
    }, PERMISSION_ARM_MS);
    this.armTimers.add(timer);
  }

  protected verb(kind: StepKind): string {
    return VERBS[kind].padEnd(VERB_WIDTH);
  }

  protected time(iso: string): string {
    return formatTime(iso);
  }

  protected decisionLabel(decision: PermissionDecision): string {
    return DECISIONS[decision];
  }
}

/** Verbs are padded with spaces to equal width, so that paths line up in a column like in a terminal. */
const VERB_WIDTH = 13;
const VERBS: Record<StepKind, string> = {
  read: 'read',
  edit: 'edited',
  write: 'created',
  command: 'ran',
  search: 'searched',
  other: 'step'
};

const DECISIONS: Record<PermissionDecision, string> = {
  allow: 'allowed',
  'allow-always': 'always allowed',
  deny: 'denied'
};

/** The icon of the mode chip. */
const MODE_ICONS: Record<ConsoleMode, string> = {
  default: 'shield',
  acceptEdits: 'edit',
  plan: 'checklist'
};

function labelOf<T>(options: readonly { value: T; label: string }[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}

/** ":5-10" for lines 5 to 10, ":5" for one line, "" without a selection. */
function linesOf(file: PromptFile): string {
  if (file.startLine === undefined || file.endLine === undefined) {
    return '';
  }
  return file.startLine === file.endLine ? `:${file.startLine}` : `:${file.startLine}-${file.endLine}`;
}
