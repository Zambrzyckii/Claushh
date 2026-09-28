/**
 * Contract of the terminal SignalR hub (`/hubs/terminal`). Description: docs/ARCHITECTURE.md, section "Terminal".
 *
 * Each terminal is a tmux session on the server started in the project directory. It keeps living after the browser
 * tab is closed. Reattaching (`Attach`) returns a snapshot of the screen and history, and further output arrives
 * as `TerminalOutput` events with an increasing `seq` number, so that no fragments are duplicated or lost.
 */

export interface TerminalInfo {
  id: string;
  /** Tab name, e.g. the directory name. */
  title: string;
  /** Start directory relative to the projects directory (`''` = the whole projects directory). */
  cwd: string;
  /** The shell process has exited (e.g. `exit`). The terminal stays until the user closes it. */
  exited: boolean;
}

export interface TerminalAttachment {
  /** Screen and history content with ANSI sequences, to write into xterm after `reset()`. */
  snapshot: string;
  /** Number of the last output fragment included in the snapshot. */
  seq: number;
  /** Number of the last `Input` batch accepted from the `client` given in `Attach` (0 when none). */
  inputSeq: number;
}

export interface TerminalOutput {
  id: string;
  seq: number;
  data: string;
}

export interface TerminalExit {
  id: string;
  exitCode: number | null;
}

/** `Input` argument: a batch of typed characters with the sender's (terminal view's) sequence number. */
export interface TerminalInput {
  id: string;
  /** Random identifier of the terminal view. */
  client: string;
  /** Increases by 1 for each new batch of a given `client`. A batch with `seq` not greater than the last accepted one is skipped. */
  seq: number;
  data: string;
}

export const TERMINAL_HUB = {
  url: '/hubs/terminal',
  output: 'TerminalOutput',
  exited: 'TerminalExited',
  list: 'ListTerminals',
  open: 'OpenTerminal',
  attach: 'Attach',
  input: 'Input',
  resize: 'Resize',
  close: 'CloseTerminal'
} as const;
