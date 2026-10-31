// Terminal hub of the e2e mock, with the simulated shell and its methods. server.mjs attaches it with `attachHubs` and
// lists the route order.

import { sleep } from '../http.mjs';
import { listDir, state } from '../state.mjs';
import { DROP_CONNECTION, send } from './signalr.mjs';

// ---------- terminal: simulated shell ----------

const promptFor = (terminal) => `\x1b[32mowner@dom\x1b[0m:\x1b[34m~/projekty${terminal.cwd ? '/' + terminal.cwd : ''}\x1b[0m$ `;

function terminalEmit(terminal, data) {
  terminal.seq++;
  terminal.history = (terminal.history + data).slice(-100_000);
  for (const ws of state.terminalSockets) {
    send(ws, { type: 1, target: 'TerminalOutput', arguments: [{ id: terminal.id, seq: terminal.seq, data }] });
  }
}

function runCommand(terminal, line) {
  const [command, ...rest] = line.trim().split(/\s+/);
  switch (command) {
    case undefined:
    case '':
      return '';
    case 'pwd':
      return `/srv/projects${terminal.cwd ? '/' + terminal.cwd : ''}\r\n`;
    case 'ls':
      return listDir(terminal.cwd).map((e) => e.name).sort().join('  ') + '\r\n';
    case 'echo':
      return rest.join(' ') + '\r\n';
    case 'link':
      // An OSC 8 link whose text pretends to be a different URL (the frontend disables such links).
      return '\x1b]8;;https://github-login.example/\x1b\\https://github.com/org/repo\x1b]8;;\x1b\\\r\n';
    case 'query':
      // Terminal queries, as a program sends them: a device attributes query (DA1), which gets no answer at all, and
      // a cursor position query, which tmux answers on the server; the view must not answer either
      // (docs/ARCHITECTURE.md, "Terminal").
      return '\x1b[c\x1b[6n' + 'zapytano\r\n';
    default:
      return `bash: ${command}: command not found\r\n`;
  }
}

function terminalInput(terminal, data) {
  terminal.inputs.push(data);
  if (terminal.exited) return;
  // We skip key sequences (arrows etc.) and paste mode markers.
  const text = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO.|\x1b./g, '');
  for (const ch of text) {
    if (ch === '\r') {
      const line = terminal.line;
      terminal.line = '';
      if (line.trim() === 'exit') {
        terminalEmit(terminal, '\r\nlogout\r\n');
        terminal.exited = true;
        for (const ws of state.terminalSockets) {
          send(ws, { type: 1, target: 'TerminalExited', arguments: [{ id: terminal.id, exitCode: null }] });
        }
        return;
      }
      terminalEmit(terminal, '\r\n' + runCommand(terminal, line) + promptFor(terminal));
    } else if (ch === '\x7f') {
      if (terminal.line) {
        terminal.line = terminal.line.slice(0, -1);
        terminalEmit(terminal, '\b \b');
      }
    } else if (ch === '\x03') {
      terminal.line = '';
      terminalEmit(terminal, '^C\r\n' + promptFor(terminal));
    } else if (ch >= ' ') {
      terminal.line += ch;
      terminalEmit(terminal, ch);
    }
  }
}

const terminalInfo = ({ id, title, cwd, exited }) => ({ id, title, cwd, exited });

async function invokeTerminal(target, args, ws) {
  const request = args[0] ?? {};
  const terminal = state.terminals.get(request.id);
  switch (target) {
    case 'ListTerminals':
      if (state.faults.listDelayMs) await sleep(state.faults.listDelayMs);
      return [...state.terminals.values()].map(terminalInfo);
    case 'OpenTerminal': {
      const cwd = request.projectPath ?? '';
      const base = cwd ? cwd.slice(cwd.lastIndexOf('/') + 1) : 'projects';
      const same = [...state.terminals.values()].filter((t) => t.title === base || t.title.startsWith(base + ' (')).length;
      const created = {
        id: `t${++state.terminalCounter}`,
        title: same ? `${base} (${same + 1})` : base,
        cwd,
        exited: false,
        seq: 0,
        history: '',
        line: '',
        inputs: [],
        sizes: [[request.cols, request.rows]],
        inputSeq: new Map(), // client -> last accepted seq
        inputOwner: new Map() // client -> the connection that last performed Attach (only it sends Input)
      };
      state.terminals.set(created.id, created);
      state.log.push({ path: 'terminal-open', cwd });
      terminalEmit(created, promptFor(created));
      return terminalInfo(created);
    }
    case 'Attach': {
      if (!terminal) throw new Error('Unknown terminal');
      if (state.faults.attachDelayMs) await sleep(state.faults.attachDelayMs);
      terminal.sizes.push([request.cols, request.rows]);
      const client = String(request.client ?? '');
      // A client outside 1-64 characters (the hub's limit) gets the snapshot, but takes no Input ownership.
      if (client.length >= 1 && client.length <= 64) terminal.inputOwner.set(client, ws);
      return {
        snapshot: terminal.exited ? '' : terminal.history,
        seq: terminal.seq,
        inputSeq: terminal.inputSeq.get(client) ?? 0
      };
    }
    case 'Input': {
      // An already accepted batch (retried after a dropped connection) is skipped: characters must not be duplicated.
      const client = String(request.client ?? '');
      const seq = Number(request.seq);
      const data = String(request.data ?? '');
      if (client.length < 1 || client.length > 64 || !Number.isSafeInteger(seq) || seq < 1 || data.length > 4096) {
        throw new Error('Invalid batch');
      }
      if (!terminal || terminal.exited) return null;
      // Batches are accepted only from the connection that last performed Attach for this sender. Late batches from the
      // old connection are rejected (`inputSeq` from Attach is final, and "Discard" really discards),
      // and a new connection must attach first (then the client knows what arrived and holds back old characters).
      if (terminal.inputOwner.get(client) !== ws) throw new Error('Attach on this connection first');
      if (seq <= (terminal.inputSeq.get(client) ?? 0)) return null;
      terminal.inputSeq.set(client, seq);
      terminalInput(terminal, data);
      if (state.faults.dropInputAck > 0) {
        state.faults.dropInputAck--;
        state.hubDownUntil = Date.now() + state.faults.downAfterDropMs;
        return DROP_CONNECTION;
      }
      return null;
    }
    case 'Resize':
      terminal?.sizes.push([request.cols, request.rows]);
      return null;
    case 'CloseTerminal':
      // An unknown id is not an error: another tab may have closed the terminal already (contract, "Terminal").
      if (!terminal) return null;
      state.terminals.delete(request.id);
      state.log.push({ path: 'terminal-close', id: request.id });
      return null;
    default:
      throw new Error(`Unknown method ${target}`);
  }
}

export const terminalHub = { sockets: () => state.terminalSockets, invoke: invokeTerminal };
