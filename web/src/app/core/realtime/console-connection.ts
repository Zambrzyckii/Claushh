import { Injectable } from '@angular/core';
import { HubConnection } from '@microsoft/signalr';
import { Observable, Subject } from 'rxjs';

import {
  CONSOLE_HUB,
  ConsoleEvent,
  ConversationSnapshot,
  PermissionDecision,
  SendPromptRequest
} from './console-protocol';
import { HubClient } from './hub-client';

export type { ConnectionState } from './hub-client';

/**
 * SignalR connection to the console hub (`/hubs/console`). Connecting, reconnecting and session control: HubClient.
 * Contract: docs/ARCHITECTURE.md, section "Console".
 */
@Injectable()
export class ConsoleConnection extends HubClient {
  private readonly events$ = new Subject<ConsoleEvent>();
  readonly events: Observable<ConsoleEvent> = this.events$.asObservable();

  protected readonly url = CONSOLE_HUB.url;
  protected readonly label = 'konsolą';

  protected register(connection: HubConnection): void {
    connection.on(CONSOLE_HUB.event, (event: ConsoleEvent) => this.events$.next(event));
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
}
