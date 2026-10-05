import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ProjectContext } from '../../core/project/project-context';
import { ConsoleConnection } from '../../core/realtime/console-connection';
import {
  ConsoleEvent,
  ConsoleOptions,
  ConsoleState,
  PermissionDecision,
  StepKind
} from '../../core/realtime/console-protocol';

/**
 * State of the Console panel: conversation entries built from hub events, work state, pending permission request.
 *
 * Every event (live and replayed by `GetConversation`) goes through the same `apply` function,
 * so the view after a page reload looks the same as live. The conversation belongs to the project
 * from ProjectContext. Changing the project loads its latest conversation.
 */

export interface ConsoleStep {
  stepId: string;
  kind: StepKind;
  target: string;
  added?: number;
  removed?: number;
  output: { text: string; isError: boolean }[];
}

export type ConsoleEntry =
  | { kind: 'session'; startedAt: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'steps'; steps: ConsoleStep[] }
  | { kind: 'text'; messageId: string; text: string }
  | { kind: 'permission'; requestId: string; description: string; alwaysRule: string | null; decision: PermissionDecision | null }
  | { kind: 'notice'; text: string; error: boolean };

@Injectable()
export class ConsoleStore {
  private readonly connection = inject(ConsoleConnection);
  private readonly project = inject(ProjectContext);

  private readonly conversationId = signal<string | null>(null);
  private readonly entriesSignal = signal<readonly ConsoleEntry[]>([]);
  private readonly stateSignal = signal<ConsoleState>('idle');
  private readonly loading = signal(false);
  /**
   * A prompt is being sent or a new conversation is being created (until the server responds): a second Enter during this time sends nothing.
   */
  private readonly sending = signal(false);
  private readonly failure = signal<string | null>(null);

  readonly entries = this.entriesSignal.asReadonly();
  /** Current conversation (`null` before the first prompt in the project). */
  readonly conversation = this.conversationId.asReadonly();
  readonly state = this.stateSignal.asReadonly();
  readonly connectionState = this.connection.state;
  readonly error = this.failure.asReadonly();
  readonly options = signal<ConsoleOptions>({ model: 'opus', effort: 'medium', mode: 'default' });

  readonly pendingPermission = computed(() => {
    const entries = this.entriesSignal();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.kind === 'permission' && entry.decision === null) {
        return entry;
      }
    }
    return null;
  });

  /** Whether a prompt can be sent: there is a connection, the conversation is loaded and Claude is not working. */
  readonly canSend = computed(
    () =>
      this.connection.state() === 'connected' &&
      !this.loading() &&
      !this.sending() &&
      this.stateSignal() !== 'working' &&
      this.stateSignal() !== 'waiting'
  );

  constructor() {
    this.connection.events.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((event) => this.onEvent(event));
    this.connection.reconnected.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe(() => void this.loadConversation());

    effect(() => {
      this.project.path();
      untracked(() => void this.init());
    });

    // Automatic connection attempts have ended (e.g. a long network outage): show "reconnect".
    let wasConnected = false;
    effect(() => {
      const state = this.connection.state();
      untracked(() => {
        if (state === 'connected') {
          wasConnected = true;
        } else if (state === 'disconnected' && wasConnected && !this.failure()) {
          this.failure.set('No connection to the console.');
        }
      });
    });
  }

  /** Sends a prompt. The prompt text appears in the conversation only as an event from the server. */
  async send(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || !this.canSend()) {
      return false;
    }
    // Lock right away, before the first await: otherwise a second Enter during `StartConversation` would create a second
    // conversation and send the same prompt again.
    this.sending.set(true);
    this.failure.set(null);
    try {
      let conversationId = this.conversationId();
      if (!conversationId) {
        conversationId = await this.connection.startConversation(this.project.path());
        this.switchTo(conversationId);
      }
      // The "working" state right away, so that it cannot be sent a second time before the server responds.
      this.stateSignal.set('working');
      await this.connection.sendPrompt({ conversationId, text: trimmed, ...this.options() });
      return true;
    } catch {
      this.stateSignal.set('idle');
      this.failure.set('Could not send the prompt.');
      return false;
    } finally {
      this.sending.set(false);
    }
  }

  async answer(requestId: string, decision: PermissionDecision): Promise<void> {
    const conversationId = this.conversationId();
    if (!conversationId) {
      return;
    }
    try {
      await this.connection.answerPermission(conversationId, requestId, decision);
    } catch {
      this.failure.set('Could not send the answer.');
    }
  }

  async interrupt(): Promise<void> {
    const conversationId = this.conversationId();
    if (conversationId && (this.stateSignal() === 'working' || this.stateSignal() === 'waiting')) {
      await this.connection.interrupt(conversationId).catch(() => this.failure.set('Could not interrupt.'));
    }
  }

  /** A new, empty conversation in the same project. The previous one stays on the server. */
  async newConversation(): Promise<void> {
    if (this.sending() || this.stateSignal() === 'working' || this.stateSignal() === 'waiting') {
      return;
    }
    // The same lock as when sending: a prompt sent in the meantime would still go to the previous conversation.
    this.sending.set(true);
    this.failure.set(null);
    try {
      this.switchTo(await this.connection.startConversation(this.project.path()));
    } catch {
      this.failure.set('Could not start a new conversation.');
    } finally {
      this.sending.set(false);
    }
  }

  async retryConnection(): Promise<void> {
    await this.init();
  }

  private async init(): Promise<void> {
    this.failure.set(null);
    if (!(await this.connection.connect())) {
      this.failure.set('No connection to the console.');
      return;
    }
    await this.loadConversation();
  }

  private async loadConversation(): Promise<void> {
    const projectPath = this.project.path();
    this.loading.set(true);
    try {
      const snapshot = await this.connection.getConversation(projectPath);
      if (projectPath !== this.project.path()) {
        return; // the project was changed in the meantime
      }
      this.conversationId.set(snapshot.conversationId);
      this.entriesSignal.set([]);
      this.stateSignal.set('idle');
      for (const event of snapshot.events) {
        this.apply(event);
      }
    } catch {
      this.failure.set('Could not load the conversation.');
    } finally {
      this.loading.set(false);
    }
  }

  private switchTo(conversationId: string): void {
    if (this.conversationId() !== conversationId) {
      this.conversationId.set(conversationId);
      this.entriesSignal.set([]);
      this.stateSignal.set('idle');
    }
  }

  private onEvent(event: ConsoleEvent): void {
    if (event.type === 'conversation') {
      // A new conversation in this project, e.g. started in another tab or on another device.
      if (event.projectPath === this.project.path()) {
        this.switchTo(event.conversationId);
        this.apply(event);
      }
      return;
    }
    if (event.conversationId !== this.conversationId()) {
      return;
    }
    this.apply(event);
    if (event.type === 'files-changed') {
      this.project.announceFilesChanged(event.paths);
    }
  }

  private apply(event: ConsoleEvent): void {
    switch (event.type) {
      case 'conversation':
        this.push({ kind: 'session', startedAt: event.startedAt });
        break;
      case 'prompt':
        this.push({ kind: 'prompt', text: event.text });
        break;
      case 'step': {
        const step: ConsoleStep = {
          stepId: event.stepId,
          kind: event.kind,
          target: event.target,
          added: event.added,
          removed: event.removed,
          output: []
        };
        this.entriesSignal.update((entries) => {
          const last = entries.at(-1);
          return last?.kind === 'steps'
            ? [...entries.slice(0, -1), { kind: 'steps', steps: [...last.steps, step] }]
            : [...entries, { kind: 'steps', steps: [step] }];
        });
        break;
      }
      case 'step-output':
        this.entriesSignal.update((entries) =>
          entries.map((entry) =>
            entry.kind === 'steps' && entry.steps.some((s) => s.stepId === event.stepId)
              ? {
                  kind: 'steps',
                  steps: entry.steps.map((s) =>
                    s.stepId === event.stepId ? { ...s, output: [...s.output, { text: event.text, isError: event.isError }] } : s
                  )
                }
              : entry
          )
        );
        break;
      case 'text':
        this.entriesSignal.update((entries) => {
          const index = entries.findIndex((e) => e.kind === 'text' && e.messageId === event.messageId);
          if (index === -1) {
            return [...entries, { kind: 'text', messageId: event.messageId, text: event.delta }];
          }
          const existing = entries[index] as Extract<ConsoleEntry, { kind: 'text' }>;
          const copy = [...entries];
          copy[index] = { ...existing, text: existing.text + event.delta };
          return copy;
        });
        break;
      case 'permission':
        this.push({
          kind: 'permission',
          requestId: event.requestId,
          description: event.description,
          alwaysRule: event.alwaysRule || null,
          decision: null
        });
        break;
      case 'permission-resolved':
        this.entriesSignal.update((entries) =>
          entries.map((e) => (e.kind === 'permission' && e.requestId === event.requestId ? { ...e, decision: event.decision } : e))
        );
        break;
      case 'status':
        this.stateSignal.set(event.state);
        if (event.state === 'error') {
          this.push({ kind: 'notice', text: event.message ?? 'An error occurred.', error: true });
        } else if (event.message) {
          this.push({ kind: 'notice', text: event.message, error: false });
        }
        break;
      case 'files-changed':
        break;
    }
  }

  private push(entry: ConsoleEntry): void {
    this.entriesSignal.update((entries) => [...entries, entry]);
  }
}
