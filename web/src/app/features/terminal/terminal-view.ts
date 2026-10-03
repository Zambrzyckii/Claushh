import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { Subscription } from 'rxjs';

import { Dialogs } from '../../core/browser/dialogs';
import { isTypingElsewhere } from '../../core/browser/focus';
import { TerminalInfo } from '../../core/realtime/terminal-protocol';
import { countLabel } from '../../core/text/polish';
import { previewText } from '../../core/text/visible-text';
import { MAX_PENDING_INPUT, lineBreaks, sanitizePaste } from './terminal-input';
import { TerminalStore } from './terminal-store';
import { TERMINAL_OPTIONS, loadXterm } from './xterm-loader';

/**
 * Characters typed during a disconnection are sent after reattaching without asking, if they waited less than this many ms.
 * Those waiting longer require a decision: after a longer break the user may have forgotten what they typed.
 */
export const AUTO_RESEND_MS = 5_000;
/**
 * Room for the paste mode markers (`\x1b[200~` … `\x1b[201~`, 12 characters) that xterm adds to the pasted text
 * when the shell has turned this mode on. Without this room, text just under the queue limit would be rejected.
 */
const PASTE_MARGIN = 16;

/**
 * One xterm.js terminal attached to a session on the server.
 *
 * Attaching (`attach`) writes the screen snapshot from the server, and then appends further output. Output fragments
 * have `seq` numbers: those that arrived during attaching are buffered, and those already contained in the snapshot are skipped.
 * After reconnecting to the hub the terminal attaches again. The size fits the container
 * (FitAddon + ResizeObserver) and is sent to the server.
 *
 * Typing safety (docs/ARCHITECTURE.md, section "Terminal"):
 * - typed characters go through the terminal queue from TerminalStore (TerminalInputQueue): nothing is lost on a dropped
 *   connection and nothing is duplicated. Characters waiting longer than `AUTO_RESEND_MS` are paused until a decision
 *   in the panel above the terminal ("Wyślij" (send) / "Porzuć" (discard)),
 * - pasted text is cleaned of control characters, and text with line endings waits for a decision in a panel
 *   with a full preview ("Wklej" (paste) / "Anuluj" (cancel)),
 * - questions are panels on the page, not `confirm` windows: those stop the page (including the session timer), and Chrome
 *   truncates long text in them without warning,
 * - OSC 8 links are disabled (the link text could pretend to be a different address),
 * - terminal queries are left to tmux on the server, which answers some of them (an answer from every open view would reach the program),
 * - focus after attaching only when the user is not typing somewhere else at that time.
 */
@Component({
  selector: 'app-terminal-view',
  template: `
    <div #host class="host"></div>
    @if (loadFailed()) {
      <p class="failed" role="alert">Nie udało się załadować terminala. Odśwież stronę.</p>
    }
    @if (pasteRequest(); as request) {
      <div class="decision decision--top" role="alertdialog" [attr.aria-labelledby]="ids.pasteTitle"
           [attr.aria-describedby]="ids.pasteText" (keydown.escape)="cancelPaste()">
        <p [id]="ids.pasteTitle">
          Wklejany tekst ma {{ request.breaksLabel }}, więc może od razu uruchomić komendy. Wkleić do terminala?
        </p>
        <pre [id]="ids.pasteText">{{ request.preview }}</pre>
        <div>
          <button type="button" (click)="confirmPaste()">Wklej</button>
          <button #cancelPasteButton type="button" (click)="cancelPaste()">Anuluj</button>
        </div>
      </div>
    }
    @if (inputState().held) {
      <div class="decision" role="alertdialog" [attr.aria-labelledby]="ids.staleTitle" [attr.aria-describedby]="ids.staleText">
        <p [id]="ids.staleTitle">W czasie rozłączenia wpisano znaki, które nie dotarły do terminala. Wysłać je teraz?</p>
        <pre [id]="ids.staleText">{{ stalePreview() }}</pre>
        <p class="faint">Terminal pokazuje to, co już do niego dotarło. „Porzuć” usuwa tylko powyższe znaki.</p>
        <div>
          <button type="button" (click)="sendStaleInput()">Wyślij</button>
          <button type="button" (click)="discardStaleInput()">Porzuć</button>
        </div>
      </div>
    } @else if (inputNotice(); as notice) {
      <p class="notice" role="status">{{ notice }}</p>
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
    .notice {
      position: absolute;
      right: 12px;
      bottom: 8px;
      margin: 0;
      padding: 4px 8px;
      background: var(--surface);
      border: 1px solid var(--accent);
      border-radius: 3px;
      color: var(--accent);
      font-size: 12px;
    }
    .decision {
      position: absolute;
      right: 12px;
      bottom: 8px;
      max-width: min(560px, calc(100% - 24px));
      max-height: calc(100% - 16px);
      overflow: auto;
      padding: 8px 12px;
      background: var(--surface);
      border: 1px solid var(--accent);
      border-radius: 3px;
      font-size: 12px;

      &--top {
        top: 8px;
        bottom: auto;
      }
      p {
        margin: 0 0 6px;
      }
      pre {
        margin: 0 0 6px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-family: var(--font-mono);
        color: var(--text-strong);
      }
      .faint {
        color: var(--text-muted);
      }
      button {
        margin-right: 8px;
        padding: 3px 10px;
        background: transparent;
        border: 1px solid var(--border-strong);
        border-radius: 3px;
        color: var(--text);
      }
    }
  `
})
export class TerminalView {
  readonly terminal = input.required<TerminalInfo>();

  private readonly store = inject(TerminalStore);
  private readonly dialogs = inject(Dialogs);
  private readonly injector = inject(Injector);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly cancelPasteButton = viewChild<ElementRef<HTMLButtonElement>>('cancelPasteButton');
  private readonly subscriptions = new Subscription();

  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private attached = false;
  private lastSeq = 0;
  private pending: { seq: number; data: string }[] = [];
  private exitShown = false;
  private destroyed = false;

  /** Queue of typed characters of this terminal (belongs to TerminalStore, `inputQueue` creates it on first use). */
  private readonly inputQueue = computed(() => this.store.inputQueue(this.terminal().id));
  protected readonly inputState = computed(() => this.inputQueue().state());

  /** Unique identifiers of panel elements (there are several terminals in the panel at once). */
  protected readonly ids = panelIds(`term-${crypto.randomUUID()}`);

  protected readonly loadFailed = signal(false);
  /** Pasted text with line endings waiting for a decision ("Wklej" / "Anuluj"). */
  protected readonly pasteRequest = signal<{ text: string; preview: string; breaksLabel: string } | null>(null);
  protected readonly stalePreview = computed(() => previewText(this.inputState().heldText.replace(/\r\n?/g, '\n')));
  /** Message when typed characters are waiting for the connection or were rejected. */
  protected readonly inputNotice = computed(() => {
    const { text, overflow } = this.inputState();
    if (overflow) {
      return 'Za dużo znaków czeka na wysłanie. Dalsze są pomijane, aż te dotrą.';
    }
    if (!text) {
      return null;
    }
    switch (this.store.connectionState()) {
      case 'connected':
        return null;
      case 'disconnected':
        return 'Brak połączenia z terminalem. Wpisane znaki czekają, aż połączenie wróci („połącz ponownie” nad terminalem).';
      default:
        return 'Brak połączenia. Wpisane znaki zostaną wysłane po ponownym połączeniu.';
    }
  });

  constructor() {
    afterNextRender(() => void this.init());

    effect(() => {
      if (this.terminal().exited) {
        untracked(() => this.showExit());
      }
    });

    // Without a connection the view stops being attached: characters wait in the queue, and output in the buffer, until the next `attach`
    // confirms what arrived and pauses characters that are too old (also when the connection comes back via a manual "połącz ponownie").
    effect(() => {
      if (this.store.connectionState() !== 'connected') {
        this.attached = false;
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
    const host = this.host().nativeElement;
    const term = new xterm.Terminal(TERMINAL_OPTIONS);
    const fit = new xterm.FitAddon();
    term.loadAddon(fit);
    // OSC 8 links disabled: the visible text ("https://github.com/…") could lead somewhere else.
    // A handler that returns `true` takes over the sequence, so xterm does not create a link. The text itself is displayed.
    term.parser.registerOscHandler(8, () => true);
    // Terminal queries (device attributes, cursor position, modes, colours) are left to tmux on the server: it
    // answers the cursor position report, the mode report and the colour queries, and passes every query on to every
    // view, so xterm answering too would type one more reply per open tab into the program (e.g. "^[[<row>;<col>R"
    // in vim). Device attributes get no answer at all (tmux does not answer them either), which is accepted: an
    // answer from the view would have the same per-tab duplication problem. A handler that returns `true` takes the
    // sequence over, so xterm sends nothing.
    const queries = [
      { final: 'c' },
      { prefix: '>', final: 'c' },
      { final: 'n' },
      { prefix: '?', final: 'n' },
      { intermediates: '$', final: 'p' },
      { prefix: '?', intermediates: '$', final: 'p' }
    ];
    for (const query of queries) {
      term.parser.registerCsiHandler(query, () => true);
    }
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
    // Colour queries ("?") only: setting a colour still works.
    for (const colour of [4, 10, 11, 12]) {
      term.parser.registerOscHandler(colour, (data) => data.split(';').includes('?'));
    }
    term.open(host);
    this.term = term;
    this.fit = fit;
    this.fitToContainer();

    // Custom paste handling in the capture phase, before xterm's handling (which would pass the text on unchecked).
    host.addEventListener('paste', (event) => this.onPaste(event), { capture: true });

    term.onData((data) => {
      if (this.terminal().exited) {
        return;
      }
      const queue = this.inputQueue();
      if (!queue.push(data) && !queue.state().overflow) {
        // A single fragment larger than the whole queue (in practice only a very long paste).
        this.dialogs.alert('Tekst jest za długi dla terminala i nie został wysłany. Zapisz go do pliku w edytorze.');
      }
      void this.flushInput();
    });
    term.onResize(({ cols, rows }) => {
      if (this.attached) {
        this.store.resize(this.id, cols, rows);
      }
    });
    this.subscriptions.add(this.store.output(this.id).subscribe((chunk) => this.onOutput(chunk)));
    this.subscriptions.add(this.store.reattach.subscribe(() => void this.attach()));

    this.resizeObserver = new ResizeObserver(() => this.fitToContainer());
    this.resizeObserver.observe(host);

    await this.attach();
    if (!this.destroyed && !isTypingElsewhere(host)) {
      term.focus();
    }
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
      // Characters that waited too long keep waiting until the user decides in the panel.
      this.inputQueue().holdIfStale(AUTO_RESEND_MS);
      void this.flushInput();
    } catch {
      term.write('\r\n\x1b[2m[nie udało się podłączyć terminala]\x1b[0m\r\n');
    }
  }

  /** Sends the waiting characters if the view is attached (the queue will not send paused ones on its own). */
  private flushInput(): Promise<void> {
    return this.attached ? this.inputQueue().flush() : Promise.resolve();
  }

  protected sendStaleInput(): void {
    this.inputQueue().approvePending();
    void this.flushInput();
    this.term?.focus();
  }

  protected discardStaleInput(): void {
    this.inputQueue().discard();
    this.term?.focus();
  }

  protected confirmPaste(): void {
    const request = this.pasteRequest();
    this.pasteRequest.set(null);
    if (request && this.term && !this.terminal().exited) {
      // `paste` from xterm turns line endings into `\r` and adds the paste mode markers if the shell has turned it on.
      this.term.paste(request.text);
    }
    this.term?.focus();
  }

  protected cancelPaste(): void {
    this.pasteRequest.set(null);
    this.term?.focus();
  }

  private onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    const term = this.term;
    if (!term || this.terminal().exited) {
      return;
    }
    const text = sanitizePaste(event.clipboardData?.getData('text/plain') ?? '');
    if (!text) {
      return;
    }
    if (text.length > MAX_PENDING_INPUT - PASTE_MARGIN) {
      this.dialogs.alert(
        `Wklejany tekst jest za długi dla terminala (${countLabel(text.length, 'znak', 'znaki', 'znaków')}, ` +
          `najwyżej ${MAX_PENDING_INPUT - PASTE_MARGIN}). Zapisz go do pliku w edytorze albo wklej w częściach.`
      );
      return;
    }
    const breaks = lineBreaks(text);
    if (breaks === 0) {
      term.paste(text);
      return;
    }
    // Text with line endings waits for a decision. Focus on "Anuluj": Enter or Esc will not paste anything and will not reach the shell.
    this.pasteRequest.set({
      text,
      preview: previewText(text.replace(/\r\n?/g, '\n')),
      breaksLabel: countLabel(breaks, 'koniec linii', 'końce linii', 'końców linii')
    });
    afterNextRender(() => this.cancelPasteButton()?.nativeElement.focus(), { injector: this.injector });
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

function panelIds(prefix: string) {
  return {
    pasteTitle: `${prefix}-paste-title`,
    pasteText: `${prefix}-paste-text`,
    staleTitle: `${prefix}-stale-title`,
    staleText: `${prefix}-stale-text`
  };
}
