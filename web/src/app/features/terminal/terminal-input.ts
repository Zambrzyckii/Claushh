import { signal } from '@angular/core';

/**
 * Typing into the terminal without losing or duplicating characters, and safe pasting.
 * Description: docs/ARCHITECTURE.md, section "Terminal".
 */

/** Maximum number of characters waiting to be sent (e.g. during a disconnection). Further typing is paused. */
export const MAX_PENDING_INPUT = 64 * 1024;
/**
 * Maximum number of characters in one `Input` call. The SignalR server accepts messages up to 32 KB by default,
 * and control characters in JSON take up to 6 bytes (`\u001b`).
 */
const MAX_BATCH = 4096;

export type SendInput = (client: string, seq: number, data: string) => Promise<void>;

export interface InputQueueState {
  /** Unconfirmed characters in sending order. */
  text: string;
  /** Sending paused until the user decides (the characters waited too long, `holdIfStale`). */
  held: boolean;
  /** When paused: characters that certainly did not arrive (without the batch that is currently on its way). */
  heldText: string;
  /** Further characters are rejected because the queue exceeded `MAX_PENDING_INPUT`. */
  overflow: boolean;
}

/**
 * Queue of typed characters of one terminal. It belongs to TerminalStore, so it survives closing the panel
 * and has one sender identifier (`client`) per terminal.
 *
 * - Characters go in order, one batch at a time, through `invoke` (the server confirms receipt).
 *   What was typed during sending waits and goes in the next batch.
 * - A dropped connection loses nothing: the unconfirmed batch stays and after reattaching goes again
 *   with the same `seq` number, and the server skips batches it already has (the `client` + `seq` pair). `Attach` returns the number
 *   of the last accepted batch (`acknowledge`), so it is known whether the unconfirmed batch arrived.
 *   Thanks to this there is no situation where part of a command was lost, but the Enter arrived and ran its beginning.
 * - Characters that waited too long (`holdIfStale`) are paused until the user decides: `approvePending` sends,
 *   `discard` drops. The lock is here, not in the view, so no sending loop will bypass it.
 * - The queue has a limit of `MAX_PENDING_INPUT`. After it is exceeded, further characters are rejected until the queue empties
 *   (Enter is rejected too, so a truncated command will not run).
 */
export class TerminalInputQueue {
  /** Sender identifier for skipping repeated batches on the server. */
  readonly client = crypto.randomUUID();
  private seq = 0;
  private queued = '';
  private inflight: { seq: number; data: string } | null = null;
  /** Since when (ms) they have been waiting: the sent, unconfirmed batch and the characters not sent yet. */
  private inflightSinceMs: number | null = null;
  private queuedSinceMs: number | null = null;
  private sending = false;
  private held = false;
  private overflowed = false;

  private readonly stateSignal = signal<InputQueueState>({ text: '', held: false, heldText: '', overflow: false });
  readonly state = this.stateSignal.asReadonly();

  constructor(private readonly send: SendInput) {}

  /** Adds typed characters. `false` when the characters were rejected (queue full or fragment too long). */
  push(data: string, now = Date.now()): boolean {
    if (data.length > MAX_PENDING_INPUT) {
      return false;
    }
    if (this.overflowed || this.pendingLength() + data.length > MAX_PENDING_INPUT) {
      // Something is always waiting here (otherwise the fragment would fit), so the lock will go away when the queue empties.
      this.overflowed = true;
      this.changed();
      return false;
    }
    this.queued += data;
    this.queuedSinceMs ??= now;
    this.changed();
    return true;
  }

  /** Sends everything in order. On an error (no connection) it stops, and the unsent characters wait for the next attempt. */
  async flush(): Promise<void> {
    if (this.sending) {
      return;
    }
    this.sending = true;
    try {
      for (;;) {
        if (this.held) {
          break; // waiting for the user's decision
        }
        if (!this.inflight) {
          if (!this.queued) {
            break;
          }
          const size = batchSize(this.queued);
          this.inflight = { seq: ++this.seq, data: this.queued.slice(0, size) };
          this.inflightSinceMs = this.queuedSinceMs;
          this.queued = this.queued.slice(size);
          if (!this.queued) {
            this.queuedSinceMs = null;
          }
        }
        const sent = this.inflight;
        try {
          await this.send(this.client, sent.seq, sent.data);
        } catch {
          return;
        }
        // The batch could have been confirmed by `acknowledge` or dropped by `discard` in the meantime.
        if (this.inflight === sent) {
          this.dropInflight();
        }
      }
    } finally {
      this.sending = false;
      if (this.held) {
        this.changed(); // the unconfirmed batch is no longer on its way, so the question covers it
      }
    }
  }

  /**
   * The server has already accepted batches up to and including `seq` (result of `Attach`). An unconfirmed batch with that number arrived
   * before the connection dropped: there is no need to send it or ask the user about it.
   */
  acknowledge(seq: number): void {
    if (this.inflight && this.inflight.seq <= seq) {
      this.dropInflight();
    }
  }

  get hasPending(): boolean {
    return this.inflight !== null || this.queued !== '';
  }

  /**
   * Pauses sending if characters that certainly did not arrive have been waiting at least `maxAgeMs`.
   * The batch that is currently on its way (being sent) does not count: it can no longer be stopped.
   * Returns whether sending is paused.
   */
  holdIfStale(maxAgeMs: number, now = Date.now()): boolean {
    const since = this.undeliveredSince();
    if (!this.held && since !== null && now - since >= maxAgeMs) {
      this.held = true;
      this.changed();
    }
    return this.held;
  }

  /**
   * The user agreed to send the waiting characters. The next attach will send them without asking
   * (e.g. when the connection drops again before they arrive).
   */
  approvePending(now = Date.now()): void {
    this.held = false;
    if (this.inflight) {
      this.inflightSinceMs = now;
    }
    if (this.queued) {
      this.queuedSinceMs = now;
    }
    this.changed();
  }

  /**
   * Drops the characters that did not arrive (the user does not want to send what they typed during the disconnection).
   * A batch on its way cannot be taken back: it stays until confirmed.
   */
  discard(): void {
    if (!this.sending) {
      this.inflight = null;
      this.inflightSinceMs = null;
    }
    this.queued = '';
    this.queuedSinceMs = null;
    this.held = false;
    this.overflowed = false;
    this.changed();
  }

  private dropInflight(): void {
    this.inflight = null;
    this.inflightSinceMs = null;
    if (!this.queued) {
      this.overflowed = false;
    }
    this.changed();
  }

  private pendingLength(): number {
    return (this.inflight?.data.length ?? 0) + this.queued.length;
  }

  /** A batch that is not on its way and has not been confirmed certainly did not arrive (see `acknowledge`). */
  private undeliveredText(): string {
    return (!this.sending && this.inflight ? this.inflight.data : '') + this.queued;
  }

  private undeliveredSince(): number | null {
    return (!this.sending && this.inflight ? this.inflightSinceMs : null) ?? this.queuedSinceMs;
  }

  private changed(): void {
    if (this.held && this.undeliveredText() === '') {
      this.held = false; // there is nothing left to ask about (e.g. the batch turned out to be delivered)
    }
    this.stateSignal.set({
      text: (this.inflight?.data ?? '') + this.queued,
      held: this.held,
      heldText: this.held ? this.undeliveredText() : '',
      overflow: this.overflowed
    });
  }
}

/** Batch size: up to `MAX_BATCH` characters, without splitting a surrogate pair (characters outside the BMP, e.g. emoji). */
function batchSize(text: string): number {
  if (text.length <= MAX_BATCH) {
    return text.length;
  }
  const last = text.charCodeAt(MAX_BATCH - 1);
  return last >= 0xd800 && last <= 0xdbff ? MAX_BATCH - 1 : MAX_BATCH;
}

/**
 * Clipboard text before pasting into the terminal. Removes control characters other than tab and line endings:
 * `ESC` would allow ending paste mode (`\x1b[201~`) and running the rest of the text as commands, and `DEL`, `^C`,
 * `^D` etc. would act like pressed keys. Also removes C1 characters (0x80–0x9F, e.g. 8-bit CSI).
 */
export function sanitizePaste(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

/** Number of line endings (`\r\n`, `\n` or `\r`). Each one can run a command right away. */
export function lineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

/**
 * A character typed after the sticky Ctrl key of the phone keys, as a terminal sends it: @, A-Z (either case), [, \, ],
 * ^ and _ to their control codes, space to NUL, ? to DEL. Anything else, also more than one character, passes unchanged.
 */
export function withCtrl(data: string): string {
  if (data.length !== 1) {
    return data;
  }
  if (data === ' ') {
    return '\x00';
  }
  if (data === '?') {
    return '\x7f';
  }
  const code = data.charCodeAt(0);
  const upper = code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
  return upper >= 0x40 && upper <= 0x5f ? String.fromCharCode(upper & 0x1f) : data;
}
