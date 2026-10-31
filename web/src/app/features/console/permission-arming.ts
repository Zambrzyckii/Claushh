import { signal } from '@angular/core';

import { ConsoleEntry } from './console-store';

/**
 * The permission buttons ("yes", "yes, always") stay inactive for this many ms after a request appears. The request arrives
 * asynchronously and scrolls the log to the bottom, so without this a click meant for something else could land on them.
 */
export const PERMISSION_ARM_MS = 600;

/**
 * The delay of the permission buttons in the Console panel (docs/ARCHITECTURE.md, section "Console"). A request's "yes"
 * and "yes, always" stay inactive for `PERMISSION_ARM_MS` after it appears, counted anew in each conversation. A plain
 * class, like TerminalInputQueue. The panel creates it, passes it the conversation and its entries, and stops its
 * timers when it is destroyed.
 */
export class PermissionArming {
  private readonly armedSignal = signal<ReadonlySet<string>>(new Set());
  /** Permission requests that can already be answered "yes" (`PERMISSION_ARM_MS` has passed). */
  readonly armed = this.armedSignal.asReadonly();
  private readonly arming = new Set<string>();
  private readonly armTimers = new Set<ReturnType<typeof setTimeout>>();
  private armedConversation: string | null = null;

  /**
   * Starts the delay for every unanswered request not seen yet. When the conversation differs from the last call's, it
   * first starts from scratch and returns true.
   */
  track(conversation: string | null, entries: readonly ConsoleEntry[]): boolean {
    const fromScratch = conversation !== this.armedConversation;
    if (fromScratch) {
      this.armedConversation = conversation;
      this.stop();
      this.arming.clear();
      this.armedSignal.set(new Set());
    }
    for (const entry of entries) {
      if (entry.kind === 'permission' && entry.decision === null && !this.arming.has(entry.requestId)) {
        this.arm(entry.requestId);
      }
    }
    return fromScratch;
  }

  /** Clears the pending timers. */
  stop(): void {
    for (const timer of this.armTimers) {
      clearTimeout(timer);
    }
    this.armTimers.clear();
  }

  private arm(requestId: string): void {
    this.arming.add(requestId);
    const timer = setTimeout(() => {
      this.armTimers.delete(timer);
      this.armedSignal.update((ids) => new Set(ids).add(requestId));
    }, PERMISSION_ARM_MS);
    this.armTimers.add(timer);
  }
}
