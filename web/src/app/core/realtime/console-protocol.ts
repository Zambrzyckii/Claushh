/**
 * Contract of the console SignalR hub (`/hubs/console`). Description: docs/ARCHITECTURE.md, section "Console".
 *
 * The backend runs the `claude` CLI in stream-json mode and translates its output into these events.
 * All text fields come from the model or from files, so the frontend displays them only
 * as text (Angular interpolation), never as HTML.
 */

export type ConsoleModel = 'opus' | 'sonnet' | 'haiku';
export type ConsoleEffort = 'low' | 'medium' | 'high' | 'max';
export type ConsoleMode = 'default' | 'acceptEdits' | 'plan';
export type PermissionDecision = 'allow' | 'allow-always' | 'deny';
export type StepKind = 'read' | 'edit' | 'write' | 'command' | 'search' | 'other';
export type ConsoleState = 'idle' | 'working' | 'waiting' | 'error';

export interface ConsoleOptions {
  model: ConsoleModel;
  effort: ConsoleEffort;
  mode: ConsoleMode;
}

/** Events sent by the server via the `ConsoleEvent` method. */
export type ConsoleEvent =
  | { type: 'conversation'; conversationId: string; projectPath: string; startedAt: string }
  | { type: 'prompt'; conversationId: string; text: string }
  | { type: 'step'; conversationId: string; stepId: string; kind: StepKind; target: string; added?: number; removed?: number }
  | { type: 'step-output'; conversationId: string; stepId: string; text: string; isError: boolean }
  | { type: 'text'; conversationId: string; messageId: string; delta: string }
  | { type: 'permission'; conversationId: string; requestId: string; description: string }
  | { type: 'permission-resolved'; conversationId: string; requestId: string; decision: PermissionDecision }
  | { type: 'status'; conversationId: string; state: ConsoleState; message?: string }
  | { type: 'files-changed'; conversationId: string; paths: string[] };

/** Result of `GetConversation`: the last conversation in the project, reconstructed as a list of events. */
export interface ConversationSnapshot {
  conversationId: string | null;
  events: ConsoleEvent[];
}

/** Hub methods called by the client. */
export const CONSOLE_HUB = {
  url: '/hubs/console',
  event: 'ConsoleEvent',
  getConversation: 'GetConversation',
  startConversation: 'StartConversation',
  sendPrompt: 'SendPrompt',
  answerPermission: 'AnswerPermission',
  interrupt: 'Interrupt'
} as const;

export interface SendPromptRequest extends ConsoleOptions {
  conversationId: string;
  text: string;
}
