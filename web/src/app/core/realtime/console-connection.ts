import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel
} from '@microsoft/signalr';
import { Observable, Subject } from 'rxjs';

import { AuthService } from '../auth/auth.service';
import {
  CONSOLE_HUB,
  ConsoleEvent,
  ConversationSnapshot,
  PermissionDecision,
  SendPromptRequest
} from './console-protocol';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * SignalR connection to the console hub.
 *
 * - WebSocket only, without negotiation (`skipNegotiation`): a single connection, works unchanged through Cloudflare Tunnel.
 * - Authentication with the same session cookie as the API (the browser sends it when opening the WebSocket).
 *   The backend must additionally check the `Origin` header (protection against CSWSH).
 * - When the connection does not come up, we check the session. An expired session ends as on a 401 from the API
 *   (clearing the state and returning to login).
 * - Provided in the Workspace component. Logout reloads the page, which closes the connection.
 */
@Injectable()
export class ConsoleConnection implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly events$ = new Subject<ConsoleEvent>();
  private readonly reconnected$ = new Subject<void>();
  private connection: HubConnection | null = null;

  readonly state = signal<ConnectionState>('disconnected');
  readonly events: Observable<ConsoleEvent> = this.events$.asObservable();
  /** After a reconnect, the events that arrived during the break have to be fetched. */
  readonly reconnected: Observable<void> = this.reconnected$.asObservable();

  async connect(): Promise<boolean> {
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) {
      return true;
    }
    const connection = new HubConnectionBuilder()
      .withUrl(CONSOLE_HUB.url, { transport: HttpTransportType.WebSockets, skipNegotiation: true })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 20000, 30000])
      .configureLogging(LogLevel.None)
      .build();
    connection.on(CONSOLE_HUB.event, (event: ConsoleEvent) => this.events$.next(event));
    connection.onreconnecting(() => {
      this.state.set('reconnecting');
      // A dropped connection may mean an invalidated session. Then there is no point waiting for further attempts.
      void this.auth.verifySession();
    });
    connection.onreconnected(() => {
      this.state.set('connected');
      this.reconnected$.next();
    });
    connection.onclose(() => {
      if (this.connection !== connection) {
        return; // closed deliberately when the view is destroyed
      }
      this.state.set('disconnected');
      void this.auth.verifySession();
    });
    this.connection = connection;

    this.state.set('connecting');
    try {
      await connection.start();
      this.state.set('connected');
      return true;
    } catch {
      this.state.set('disconnected');
      await this.auth.verifySession();
      return false;
    }
  }

  getConversation(projectPath: string): Promise<ConversationSnapshot> {
    return this.invoke(CONSOLE_HUB.getConversation, projectPath);
  }

  startConversation(projectPath: string): Promise<string> {
    return this.invoke(CONSOLE_HUB.startConversation, projectPath);
  }

  sendPrompt(request: SendPromptRequest): Promise<void> {
    return this.invoke(CONSOLE_HUB.sendPrompt, request);
  }

  answerPermission(conversationId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    return this.invoke(CONSOLE_HUB.answerPermission, { conversationId, requestId, decision });
  }

  interrupt(conversationId: string): Promise<void> {
    return this.invoke(CONSOLE_HUB.interrupt, { conversationId });
  }

  ngOnDestroy(): void {
    const connection = this.connection;
    this.connection = null;
    void connection?.stop();
  }

  private invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.connection || this.connection.state !== HubConnectionState.Connected) {
      return Promise.reject(new Error('Brak połączenia z konsolą.'));
    }
    return this.connection.invoke<T>(method, ...args);
  }
}
