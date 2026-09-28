import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, filter, map } from 'rxjs';

import { ProjectContext } from '../../core/project/project-context';
import { TerminalConnection } from '../../core/realtime/terminal-connection';
import { TerminalAttachment, TerminalInfo } from '../../core/realtime/terminal-protocol';

/**
 * State of the Terminal tab: list of terminals (tmux sessions on the server), active terminal, opening and closing.
 *
 * The connection to the hub is created only when the tab is first opened (`init`). Terminals live on the server,
 * so after a page reload the list comes back from `ListTerminals`, and the view attaches again (`attach`).
 * A new terminal starts in the directory of the open repository (ProjectContext).
 * Provided in the Workspace component.
 */
@Injectable()
export class TerminalStore {
  private readonly connection = inject(TerminalConnection);
  private readonly project = inject(ProjectContext);

  private readonly terminalsSignal = signal<readonly TerminalInfo[]>([]);
  private readonly activeSignal = signal<string | null>(null);
  private initialized: Promise<void> | null = null;

  readonly terminals = this.terminalsSignal.asReadonly();
  readonly activeId = this.activeSignal.asReadonly();
  readonly active = computed(() => this.terminalsSignal().find((t) => t.id === this.activeSignal()) ?? null);
  readonly connectionState = this.connection.state;
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly reconnected = this.connection.reconnected;

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.connection.exited.pipe(takeUntilDestroyed(destroyRef)).subscribe((event) =>
      this.terminalsSignal.update((list) => list.map((t) => (t.id === event.id ? { ...t, exited: true } : t)))
    );
    this.connection.reconnected.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => void this.refreshList());
  }

  /** Connects to the hub and loads the terminals. Without any terminal it opens the first one right away. */
  init(): Promise<void> {
    this.initialized ??= (async () => {
      this.error.set(null);
      if (!(await this.connection.connect())) {
        this.error.set('Brak połączenia z terminalem.');
        this.initialized = null;
        return;
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
      this.error.set('Nie udało się otworzyć terminala.');
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
      this.error.set('Nie udało się zamknąć terminala.');
      return;
    }
    const list = this.terminalsSignal();
    const index = list.findIndex((t) => t.id === id);
    const remaining = list.filter((t) => t.id !== id);
    this.terminalsSignal.set(remaining);
    if (this.activeSignal() === id) {
      this.activeSignal.set(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    }
  }

  attach(id: string, cols: number, rows: number): Promise<TerminalAttachment> {
    return this.connection.attach(id, cols, rows);
  }

  /** Output of one terminal (with `seq` numbers). */
  output(id: string): Observable<{ seq: number; data: string }> {
    return this.connection.output.pipe(
      filter((event) => event.id === id),
      map((event) => ({ seq: event.seq, data: event.data }))
    );
  }

  input(id: string, data: string): void {
    this.connection.input(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.connection.resize(id, cols, rows);
  }

  private async refreshList(): Promise<void> {
    try {
      const terminals = await this.connection.list();
      this.terminalsSignal.set(terminals);
      if (!terminals.some((t) => t.id === this.activeSignal())) {
        this.activeSignal.set(terminals.at(-1)?.id ?? null);
      }
    } catch {
      this.error.set('Nie udało się wczytać terminali.');
    }
  }
}
