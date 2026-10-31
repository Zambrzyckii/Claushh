/**
 * The order of a terminal's output on its screen (docs/ARCHITECTURE.md, section "Terminal", "Rules", attaching without
 * gaps or duplicates). Chunks wait while it is not attached, which is at first and from `beginAttach` or `detach` until
 * the next `completeAttach`. `beginAttach` drops the chunks waiting so far, since the coming snapshot includes their
 * output. `completeAttach` resets the screen and writes the snapshot, then the waiting chunks. A chunk is written only
 * when its `seq` is above the last `seq` written, the snapshot's included, so nothing the snapshot holds appears twice.
 * A plain class without xterm, like TerminalInputQueue. TerminalView passes the terminal as its sink.
 */

export interface OutputChunk {
  seq: number;
  data: string;
}

export interface OutputSink {
  reset(): void;
  write(data: string): void;
}

export class TerminalOutputOrder {
  private isAttached = false;
  private lastSeq = 0;
  private pending: OutputChunk[] = [];

  constructor(private readonly sink: OutputSink) {}

  get attached(): boolean {
    return this.isAttached;
  }

  beginAttach(): void {
    this.isAttached = false;
    this.pending = [];
  }

  completeAttach(snapshot: string, seq: number): void {
    this.sink.reset();
    this.sink.write(snapshot);
    this.lastSeq = seq;
    this.isAttached = true;
    for (const chunk of this.pending) {
      this.receive(chunk);
    }
    this.pending = [];
  }

  receive(chunk: OutputChunk): void {
    if (!this.isAttached) {
      this.pending.push(chunk);
      return;
    }
    if (chunk.seq <= this.lastSeq) {
      return; // already in the snapshot
    }
    this.lastSeq = chunk.seq;
    this.sink.write(chunk.data);
  }

  detach(): void {
    this.isAttached = false;
  }
}
