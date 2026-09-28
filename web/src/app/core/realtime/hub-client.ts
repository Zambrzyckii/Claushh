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

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * Shared handling of a SignalR connection to a hub (console, terminal).
 *
 * - WebSocket only, without negotiation (`skipNegotiation`): a single connection, works unchanged through Cloudflare Tunnel.
 * - Authentication with the same session cookie as the API (the browser sends it when opening the WebSocket).
 *   The backend must additionally check the `Origin` header (protection against CSWSH).
 * - Automatic reconnection. A dropped or failed connection immediately checks the session: an expired session
 *   ends as on a 401 from the API (clearing the state and returning to login).
 * - Derived classes provide `url` and `label`, register server events in `register` and call hub methods
 *   via `invoke` / `send`.
 * - Provided in the Workspace component. Logout reloads the page, which closes the connection.
 */
@Injectable()
export abstract class HubClient implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly reconnected$ = new Subject<void>();
  private connection: HubConnection | null = null;

  readonly state = signal<ConnectionState>('disconnected');
  /** After a reconnect, whatever arrived during the break has to be fetched. */
  readonly reconnected: Observable<void> = this.reconnected$.asObservable();

  /** Hub address, e.g. `/hubs/console`. */
  protected abstract readonly url: string;
  /** Name for messages, e.g. "konsolą": "Brak połączenia z konsolą." (no connection to the console). */
  protected abstract readonly label: string;

  /** Registers handlers for events sent by the server. */
  protected abstract register(connection: HubConnection): void;

  async connect(): Promise<boolean> {
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) {
      return true;
    }
    const connection = new HubConnectionBuilder()
      .withUrl(this.url, { transport: HttpTransportType.WebSockets, skipNegotiation: true })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 20000, 30000])
      .configureLogging(LogLevel.None)
      .build();
    this.register(connection);
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

  ngOnDestroy(): void {
    const connection = this.connection;
    this.connection = null;
    void connection?.stop();
  }

  protected invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.connection || this.connection.state !== HubConnectionState.Connected) {
      return Promise.reject(new Error(`Brak połączenia z ${this.label}.`));
    }
    return this.connection.invoke<T>(method, ...args);
  }

  /** Call without waiting for the result (e.g. every character typed in the terminal). */
  protected send(method: string, ...args: unknown[]): void {
    if (this.connection?.state === HubConnectionState.Connected) {
      void this.connection.send(method, ...args).catch(() => undefined);
    }
  }
}
