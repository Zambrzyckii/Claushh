import { Injectable } from '@angular/core';
import { HubConnection } from '@microsoft/signalr';
import { Observable, Subject } from 'rxjs';

import { HubClient } from './hub-client';
import { TERMINAL_HUB, TerminalAttachment, TerminalExit, TerminalInfo, TerminalInput, TerminalOutput } from './terminal-protocol';

/**
 * SignalR connection to the terminal hub (`/hubs/terminal`). Connecting, reconnecting and session control: HubClient.
 * Contract: docs/ARCHITECTURE.md, section "Terminal".
 */
@Injectable()
export class TerminalConnection extends HubClient {
  private readonly output$ = new Subject<TerminalOutput>();
  private readonly exited$ = new Subject<TerminalExit>();
  readonly output: Observable<TerminalOutput> = this.output$.asObservable();
  readonly exited: Observable<TerminalExit> = this.exited$.asObservable();

  protected readonly url = TERMINAL_HUB.url;
  protected readonly label = 'terminalem';

  protected register(connection: HubConnection): void {
    connection.on(TERMINAL_HUB.output, (event: TerminalOutput) => this.output$.next(event));
    connection.on(TERMINAL_HUB.exited, (event: TerminalExit) => this.exited$.next(event));
  }

  list(): Promise<TerminalInfo[]> {
    return this.invoke(TERMINAL_HUB.list);
  }

  open(projectPath: string, cols: number, rows: number): Promise<TerminalInfo> {
    return this.invoke(TERMINAL_HUB.open, { projectPath, cols, rows });
  }

  /** `client`: sender of typed characters (TerminalInputQueue); the server returns the number of its last accepted batch. */
  attach(id: string, cols: number, rows: number, client: string): Promise<TerminalAttachment> {
    return this.invoke(TERMINAL_HUB.attach, { id, cols, rows, client });
  }

  /**
   * Typed characters. `invoke`, because the server confirms receipt. `client` + `seq` let the server skip a batch
   * sent again after a dropped connection (TerminalInputQueue).
   */
  input(id: string, client: string, seq: number, data: string): Promise<void> {
    return this.invoke(TERMINAL_HUB.input, { id, client, seq, data } satisfies TerminalInput);
  }

  resize(id: string, cols: number, rows: number): void {
    this.send(TERMINAL_HUB.resize, { id, cols, rows });
  }

  close(id: string): Promise<void> {
    return this.invoke(TERMINAL_HUB.close, { id });
  }
}
