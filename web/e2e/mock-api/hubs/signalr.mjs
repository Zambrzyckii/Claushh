// SignalR framing and connections of the e2e mock's hubs (JSON protocol), with the message separator, the WebSocket
// upgrade checks, sending, the handshake, ping and invocations of a connection, the dropped connection and the closing
// of an expired session's sockets. `attachHubs` takes the hubs, each `{ sockets, invoke }` keyed by its path, from
// server.mjs, which also lists the route order.

import { WebSocketServer } from 'ws';

import { ORIGIN, ORIGINS, cookies, sessionOf, validSession } from '../http.mjs';
import { state } from '../state.mjs';

const RS = '\x1e'; // message separator in the SignalR protocol

const wss = new WebSocketServer({ noServer: true });

export function attachHubs(server, hubs) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, ORIGIN);
    } catch {
      socket.destroy();
      return;
    }
    const hub = hubs[url.pathname];
    if (Date.now() < state.hubDownUntil) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!hub || !sessionOf(req) || !ORIGINS.includes(req.headers.origin)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.sid = cookies(req).sid; // so that ending the session closes its connections
      onConnection(ws, hub);
    });
  });
}

export function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message) + RS);
}

function onConnection(ws, hub) {
  let handshake = false;
  const sockets = hub.sockets();
  const ping = setInterval(() => send(ws, { type: 6 }), 5000);
  ws.on('close', () => {
    clearInterval(ping);
    sockets.delete(ws);
  });
  ws.on('message', async (raw) => {
    for (const part of raw.toString().split(RS).filter(Boolean)) {
      let message;
      try {
        message = JSON.parse(part);
      } catch {
        ws.terminate();
        return;
      }
      if (!handshake) {
        handshake = true;
        sockets.add(ws);
        ws.send('{}' + RS);
        continue;
      }
      if (message.type !== 1) continue;
      // Every invocation checks the session: an expired or invalidated one closes the connection (hub contract).
      // Hub invocations do not extend the session.
      if (!validSession(ws.sid)) {
        ws.terminate();
        return;
      }
      let result = null;
      let error;
      try {
        result = await hub.invoke(message.target, message.arguments ?? [], ws);
      } catch (e) {
        error = String(e?.message ?? e);
      }
      if (result === DROP_CONNECTION) {
        ws.terminate();
        return;
      }
      if (message.invocationId !== undefined) {
        send(ws, error ? { type: 3, invocationId: message.invocationId, error } : { type: 3, invocationId: message.invocationId, result });
      }
    }
  });
}

/** Invocation result: drop the connection without a response (simulated failure, /__test/fault). */
export const DROP_CONNECTION = Symbol('drop');

// Sessions also expire without any HTTP request: open WebSockets of an expired session are closed (hub contract).
setInterval(() => {
  for (const sid of [...state.sessions.keys()]) validSession(sid);
}, 500).unref();
