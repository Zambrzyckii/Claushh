import { Component, DestroyRef, ElementRef, afterNextRender, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { Subscription } from 'rxjs';

import { TerminalInfo } from '../../core/realtime/terminal-protocol';
import { TerminalStore } from './terminal-store';
import { TERMINAL_OPTIONS, loadXterm } from './xterm-loader';

/**
 * One xterm.js terminal attached to a session on the server.
 *
 * Attaching (`attach`) writes the screen snapshot from the server, and then appends further output. Output fragments
 * have `seq` numbers: those that arrived during attaching are buffered, and those already contained in the snapshot are skipped.
 * After reconnecting to the hub the terminal attaches again. The size fits the container
 * (FitAddon + ResizeObserver) and is sent to the server.
 */
@Component({
  selector: 'app-terminal-view',
  template: `
    <div #host class="host"></div>
    @if (loadFailed()) {
      <p class="failed" role="alert">Nie udało się załadować terminala. Odśwież stronę.</p>
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
      inset: 4px 0 0 12px;
    }
    .failed {
      position: absolute;
      margin: 12px 16px;
      color: var(--accent);
    }
  `
})
export class TerminalView {
  readonly terminal = input.required<TerminalInfo>();

  private readonly store = inject(TerminalStore);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly subscriptions = new Subscription();

  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private attached = false;
  private lastSeq = 0;
  private pending: { seq: number; data: string }[] = [];
  private exitShown = false;
  private destroyed = false;

  protected readonly loadFailed = signal(false);

  constructor() {
    afterNextRender(() => void this.init());

    effect(() => {
      if (this.terminal().exited) {
        untracked(() => this.showExit());
      }
    });

    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.subscriptions.unsubscribe();
      this.resizeObserver?.disconnect();
      this.term?.dispose();
    });
  }

  private get id(): string {
    return this.terminal().id;
  }

  private async init(): Promise<void> {
    let xterm;
    try {
      xterm = await loadXterm();
    } catch {
      this.loadFailed.set(true);
      return;
    }
    if (this.destroyed) {
      return;
    }
    const term = new xterm.Terminal(TERMINAL_OPTIONS);
    const fit = new xterm.FitAddon();
    term.loadAddon(fit);
    term.open(this.host().nativeElement);
    this.term = term;
    this.fit = fit;
    this.fitToContainer();

    term.onData((data) => {
      if (this.attached && !this.terminal().exited) {
        this.store.input(this.id, data);
      }
    });
    term.onResize(({ cols, rows }) => {
      if (this.attached) {
        this.store.resize(this.id, cols, rows);
      }
    });
    this.subscriptions.add(this.store.output(this.id).subscribe((chunk) => this.onOutput(chunk)));
    this.subscriptions.add(this.store.reconnected.subscribe(() => void this.attach()));

    this.resizeObserver = new ResizeObserver(() => this.fitToContainer());
    this.resizeObserver.observe(this.host().nativeElement);

    await this.attach();
    term.focus();
  }

  private async attach(): Promise<void> {
    const term = this.term;
    if (!term) {
      return;
    }
    this.attached = false;
    this.pending = [];
    try {
      const attachment = await this.store.attach(this.id, term.cols, term.rows);
      if (this.destroyed) {
        return;
      }
      term.reset();
      term.write(attachment.snapshot);
      this.lastSeq = attachment.seq;
      this.attached = true;
      this.exitShown = false;
      for (const chunk of this.pending) {
        this.onOutput(chunk);
      }
      this.pending = [];
      if (this.terminal().exited) {
        this.showExit();
      }
    } catch {
      term.write('\r\n\x1b[2m[nie udało się podłączyć terminala]\x1b[0m\r\n');
    }
  }

  private onOutput(chunk: { seq: number; data: string }): void {
    if (!this.attached) {
      this.pending.push(chunk);
      return;
    }
    if (chunk.seq <= this.lastSeq) {
      return; // already in the snapshot
    }
    this.lastSeq = chunk.seq;
    this.term?.write(chunk.data);
  }

  private showExit(): void {
    if (!this.term || !this.attached || this.exitShown) {
      return;
    }
    this.exitShown = true;
    this.term.write('\r\n\x1b[2m[proces zakończony]\x1b[0m\r\n');
  }

  private fitToContainer(): void {
    const element = this.host().nativeElement;
    // A hidden terminal (another tab) has size 0. We will fit it when it is visible again.
    if (element.clientWidth > 0 && element.clientHeight > 0) {
      this.fit?.fit();
    }
  }
}
