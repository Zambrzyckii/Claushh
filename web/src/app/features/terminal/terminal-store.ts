import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, filter, map, merge } from 'rxjs';

import { ProjectContext } from '../../core/project/project-context';
import { TerminalConnection } from '../../core/realtime/terminal-connection';
import { TerminalAttachment, TerminalInfo } from '../../core/realtime/terminal-protocol';
import { TerminalInputQueue } from './terminal-input';

/**
 * State of the Terminal tab: list of terminals (tmux sessions on the server), active terminal, opening and closing.
 *
 * The connection to the hub is created only when the tab is first opened (`init`). Terminals live on the server,
 * so after a page reload the list comes back from `ListTerminals`, and the view attaches again (`attach`).
 * A new terminal starts in the directory of the open repository (ProjectContext).
 * The queues of typed characters (TerminalInputQueue) are here, not in the view: characters waiting for the connection
 * survive closing the panel, and each terminal has one sender (`client`).
 * Provided in the Workspace component.
 */
@Injectable()
export class TerminalStore {
  private readonly connection = inject(TerminalConnection);
  private readonly project = inject(ProjectContext);

  private readonly terminalsSignal = signal<readonly TerminalInfo[]>([]);
  private readonly activeSignal = signal<string | null>(null);
  private readonly inputQueues = new Map<string, TerminalInputQueue>();
  private initialized: Promise<void> | null = null;

  readonly terminals = this.terminalsSignal.asReadonly();
  readonly activeId = this.activeSignal.asReadonly();
  readonly active = computed(() => this.terminalsSignal().find((t) => t.id === this.activeSignal()) ?? null);
  readonly connectionState = this.connection.state;
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  private readonly reconnectedManually$ = new Subject<void>();
  /**
   * The views should attach again: after an automatic SignalR reconnect or after a manual
   * "reconnect", when the automatic attempts have ended.
   */
  readonly reattach: Observable<void> = merge(this.connection.reconnected, this.reconnectedManually$);

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.connection.exited.pipe(takeUntilDestroyed(destroyRef)).subscribe((event) => {
      this.terminalsSignal.update((list) => list.map((t) => (t.id === event.id ? { ...t, exited: true } : t)));
      this.dropInput(event.id); // the shell is gone, the characters would be lost anyway
    });
    this.connection.reconnected.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => void this.refreshList());

    // Automatic connection attempts have ended (e.g. a long network outage): show "reconnect".
    effect(() => {
      if (this.connection.state() === 'disconnected' && this.loaded()) {
        untracked(() => {
          this.initialized = null;
          this.error.set('No connection to the terminal.');
        });
      }
    });
  }

  /** Connects to the hub and loads the terminals. Without any terminal it opens the first one right away. */
  init(): Promise<void> {
    this.initialized ??= (async () => {
      const again = this.loaded();
      this.error.set(null);
      if (!(await this.connection.connect())) {
        this.error.set('No connection to the terminal.');
        this.initialized = null;
        return;
      }
      if (again) {
        this.reconnectedManually$.next(); // the views attach right away, before anything has a chance to go out
      }
      await this.refreshList();
      this.loaded.set(true);
      if (this.terminalsSignal().length === 0) {
        await this.open();
      }
    })();
    return this.initialized;
  }

  async open(): Promise<void> {
    this.error.set(null);
    try {
      const terminal = await this.connection.open(this.project.path(), 80, 24);
      this.terminalsSignal.update((list) => [...list.filter((t) => t.id !== terminal.id), terminal]);
      this.activeSignal.set(terminal.id);
    } catch {
      this.error.set('Could not open a terminal.');
    }
  }

  activate(id: string): void {
    this.activeSignal.set(id);
  }

  /** Closes the terminal on the server (ends the tmux session together with the processes running in it). */
  async close(id: string): Promise<void> {
    try {
      await this.connection.close(id);
    } catch {
      this.error.set('Could not close the terminal.');
      return;
    }
    this.dropInput(id);
    const list = this.terminalsSignal();
    const index = list.findIndex((t) => t.id === id);
    const remaining = list.filter((t) => t.id !== id);
    this.terminalsSignal.set(remaining);
    if (this.activeSignal() === id) {
      this.activeSignal.set(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    }
  }

  /** Attaches the view. The batch of typed characters that the server already accepted before the connection dropped is confirmed. */
  async attach(id: string, cols: number, rows: number): Promise<TerminalAttachment> {
    const queue = this.inputQueue(id);
    const attachment = await this.connection.attach(id, cols, rows, queue.client);
    queue.acknowledge(attachment.inputSeq);
    return attachment;
  }

  /** Queue of typed characters of the terminal (created on first use). */
  inputQueue(id: string): TerminalInputQueue {
    let queue = this.inputQueues.get(id);
    if (!queue) {
      queue = new TerminalInputQueue((client, seq, data) => this.connection.input(id, client, seq, data));
      this.inputQueues.set(id, queue);
    }
    return queue;
  }

  /** Output of one terminal (with `seq` numbers). */
  output(id: string): Observable<{ seq: number; data: string }> {
    return this.connection.output.pipe(
      filter((event) => event.id === id),
      map((event) => ({ seq: event.seq, data: event.data }))
    );
  }


  resize(id: string, cols: number, rows: number): void {
    this.connection.resize(id, cols, rows);
  }

  private dropInput(id: string): void {
    this.inputQueues.get(id)?.discard();
    this.inputQueues.delete(id);
  }

  private async refreshList(): Promise<void> {
    try {
      const terminals = await this.connection.list();
      this.terminalsSignal.set(terminals);
      for (const id of [...this.inputQueues.keys()]) {
        if (!terminals.some((t) => t.id === id && !t.exited)) {
          this.dropInput(id); // terminal closed (e.g. in another tab) or exited
        }
      }
      if (!terminals.some((t) => t.id === this.activeSignal())) {
        this.activeSignal.set(terminals.at(-1)?.id ?? null);
      }
    } catch {
      this.error.set('Could not load the terminals.');
    }
  }
}
