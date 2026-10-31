import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';

import { ConnectionState } from '../../core/realtime/hub-client';
import { ProjectContext } from '../../core/project/project-context';
import { MAX_PENDING_INPUT } from './terminal-input';
import { TerminalOutputOrder } from './terminal-output';
import { TerminalConnection } from './terminal-connection';
import { TerminalAttachment, TerminalExit, TerminalInfo, TerminalOutput } from './terminal-protocol';
import { TerminalStore } from './terminal-store';
import { AUTO_RESEND_MS } from './terminal-view';

/**
 * Integration: the real TerminalStore with the real TerminalInputQueue and ProjectContext (router). Only the network
 * boundary is replaced: the SignalR connection (FakeTerminalConnection). No TerminalPanel and no TerminalView, so xterm
 * never loads. The test settles the fake's list, attach and input calls itself. In "output order" the store's output
 * goes into a real TerminalOutputOrder with a sink that records what it writes.
 */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One call to the fake: its arguments, and the promise the call returned for the test to resolve or reject. */
interface Call<A extends unknown[], R> {
  readonly args: A;
  readonly result: Deferred<R>;
}

const terminal = (id: string, cwd = 'studia/lab'): TerminalInfo => ({ id, title: id, cwd, exited: false });

class FakeTerminalConnection {
  readonly state = signal<ConnectionState>('disconnected');
  readonly output$ = new Subject<TerminalOutput>();
  readonly exited$ = new Subject<TerminalExit>();
  readonly reconnected$ = new Subject<void>();
  readonly output = this.output$.asObservable();
  readonly exited = this.exited$.asObservable();
  readonly reconnected = this.reconnected$.asObservable();

  connects = 0;
  readonly lists: Call<[], TerminalInfo[]>[] = [];
  readonly opens: [string, number, number][] = [];
  readonly closes: string[] = [];
  readonly attaches: Call<[string, number, number, string], TerminalAttachment>[] = [];
  readonly inputs: Call<[string, string, number, string], void>[] = [];
  readonly resizes: [string, number, number][] = [];

  async connect() {
    this.connects++;
    this.state.set('connected');
    return true;
  }
  list() {
    const result = deferred<TerminalInfo[]>();
    this.lists.push({ args: [], result });
    return result.promise;
  }
  async open(projectPath: string, cols: number, rows: number) {
    this.opens.push([projectPath, cols, rows]);
    return terminal('opened', projectPath);
  }
  async close(id: string) {
    this.closes.push(id);
  }
  attach(id: string, cols: number, rows: number, client: string) {
    const result = deferred<TerminalAttachment>();
    this.attaches.push({ args: [id, cols, rows, client], result });
    return result.promise;
  }
  input(id: string, client: string, seq: number, data: string) {
    const result = deferred<void>();
    this.inputs.push({ args: [id, client, seq, data], result });
    return result.promise;
  }
  resize(id: string, cols: number, rows: number) {
    this.resizes.push([id, cols, rows]);
  }
}

@Component({
  providers: [ProjectContext, TerminalStore, { provide: TerminalConnection, useClass: FakeTerminalConnection }],
  template: ''
})
class Host {
  readonly store = inject(TerminalStore);
  readonly connection = inject(TerminalConnection) as unknown as FakeTerminalConnection;
}

describe('Terminal (integration)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve));

  /**
   * Opens the repository `studia/lab` in the address, creates the host and runs `init()` with the server answering
   * its terminal list with `terminals`. An empty list makes `init()` open a first terminal.
   */
  async function setup(terminals: TerminalInfo[] = [terminal('t1')]) {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    await TestBed.inject(Router).navigateByUrl('/?repo=studia%2Flab');
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const { store, connection } = fixture.componentInstance;
    const ready = store.init();
    await tick();
    connection.lists[0].result.resolve(terminals);
    await ready;
    return { fixture, store, connection };
  }

  afterEach(() => TestBed.resetTestingModule());

  /** Makes the most recent `Input` call fail, as when the connection drops before the server answers. */
  const failLastInput = (connection: FakeTerminalConnection) =>
    connection.inputs.at(-1)!.result.reject(new Error('connection lost'));

  const sentData = (connection: FakeTerminalConnection) => connection.inputs.map((call) => call.args[3]);

  it('connects on first use and opens a terminal in the open repository when the server has none', async () => {
    const { store, connection } = await setup([]);

    expect(connection.connects).toBe(1);
    expect(connection.opens).toEqual([['studia/lab', 80, 24]]);
    expect(store.terminals()).toEqual([terminal('opened')]);
    expect(store.activeId()).toBe('opened');
    expect(store.loaded()).toBe(true);
    expect(store.error()).toBeNull();
  });

  it("keeps the server's terminals and makes the last one active", async () => {
    const { store, connection } = await setup([terminal('t1'), terminal('t2')]);

    expect(connection.opens).toEqual([]);
    expect(store.terminals().map((t) => t.id)).toEqual(['t1', 't2']);
    expect(store.activeId()).toBe('t2');
  });

  it("sends typed characters in acknowledged batches with the queue's client and an increasing seq", async () => {
    const { store, connection } = await setup();
    const queue = store.inputQueue('t1');

    queue.push('ls');
    const first = queue.flush();
    queue.push('\r');
    const second = queue.flush();

    expect(connection.inputs.map((call) => call.args)).toEqual([['t1', queue.client, 1, 'ls']]);
    expect(queue.state().text).toBe('ls\r');

    connection.inputs[0].result.resolve();
    await tick();

    expect(connection.inputs.map((call) => call.args)).toEqual([
      ['t1', queue.client, 1, 'ls'],
      ['t1', queue.client, 2, '\r']
    ]);
    expect(queue.state().text).toBe('\r');

    connection.inputs[1].result.resolve();
    await Promise.all([first, second]);

    expect(queue.state().text).toBe('');
  });

  it('sends a batch whose sending failed again with the same seq after attaching', async () => {
    const { store, connection } = await setup();
    const queue = store.inputQueue('t1');

    queue.push('ls');
    const failed = queue.flush();
    failLastInput(connection);
    await failed;

    expect(queue.state().text).toBe('ls');

    const attaching = store.attach('t1', 80, 24);
    connection.attaches[0].result.resolve({ snapshot: '', seq: 0, inputSeq: 0 });
    await attaching;
    const resent = queue.flush();

    expect(connection.attaches.map((call) => call.args)).toEqual([['t1', 80, 24, queue.client]]);
    expect(connection.inputs.map((call) => call.args)).toEqual([
      ['t1', queue.client, 1, 'ls'],
      ['t1', queue.client, 1, 'ls']
    ]);

    connection.inputs[1].result.resolve();
    await resent;

    expect(queue.state().text).toBe('');
  });

  it('does not send a batch the server acknowledged in Attach', async () => {
    const { store, connection } = await setup();
    const queue = store.inputQueue('t1');

    queue.push('ls');
    const failed = queue.flush();
    failLastInput(connection);
    await failed;

    expect(queue.state().text).toBe('ls');

    const attaching = store.attach('t1', 80, 24);
    connection.attaches[0].result.resolve({ snapshot: '', seq: 0, inputSeq: 1 });
    await attaching;

    expect(queue.state().text).toBe('');

    await queue.flush();

    expect(connection.inputs).toHaveLength(1);
  });

  it('holds characters that waited AUTO_RESEND_MS until approved, and discards them on request', async () => {
    const { store, connection } = await setup([terminal('t1'), terminal('t2')]);
    const queue = store.inputQueue('t1');

    queue.push('rm x', 0);
    const failed = queue.flush();
    failLastInput(connection);
    await failed;

    expect(queue.holdIfStale(AUTO_RESEND_MS, AUTO_RESEND_MS - 1)).toBe(false);
    expect(queue.state().held).toBe(false);
    expect(queue.holdIfStale(AUTO_RESEND_MS, AUTO_RESEND_MS)).toBe(true);
    expect(queue.state()).toMatchObject({ text: 'rm x', held: true, heldText: 'rm x' });

    await queue.flush();

    expect(connection.inputs).toHaveLength(1);

    queue.approvePending(AUTO_RESEND_MS + 1_000);
    const resent = queue.flush();

    expect(queue.state().held).toBe(false);
    expect(connection.inputs.map((call) => call.args)).toEqual([
      ['t1', queue.client, 1, 'rm x'],
      ['t1', queue.client, 1, 'rm x']
    ]);

    connection.inputs[1].result.resolve();
    await resent;

    expect(queue.state().text).toBe('');

    const other = store.inputQueue('t2');
    other.push('rm y', 0);
    const otherFailed = other.flush();
    failLastInput(connection);
    await otherFailed;
    other.holdIfStale(AUTO_RESEND_MS, AUTO_RESEND_MS);

    expect(other.state()).toMatchObject({ text: 'rm y', held: true });

    other.discard();

    expect(other.state()).toEqual({ text: '', held: false, heldText: '', overflow: false });
  });

  it('refuses characters beyond MAX_PENDING_INPUT until the queue empties', async () => {
    const { store, connection } = await setup();
    const queue = store.inputQueue('t1');

    expect(queue.push('a'.repeat(MAX_PENDING_INPUT))).toBe(true);
    expect(queue.push('b')).toBe(false);
    expect(queue.state().overflow).toBe(true);
    expect(queue.push('\r')).toBe(false);

    const flushing = queue.flush();
    let finished = false;
    void flushing.then(() => (finished = true));
    connection.inputs[0].result.resolve();
    await tick();

    expect(queue.state().overflow).toBe(true);

    for (let i = 0; i < 100 && !finished; i++) {
      connection.inputs.at(-1)!.result.resolve();
      await tick();
    }
    await flushing;

    expect(sentData(connection).join('')).toBe('a'.repeat(MAX_PENDING_INPUT));
    expect(queue.state()).toEqual({ text: '', held: false, heldText: '', overflow: false });
    expect(queue.push('b')).toBe(true);
  });

  it('marks an exited terminal and drops its waiting characters', async () => {
    const { store, connection } = await setup();
    const queue = store.inputQueue('t1');
    queue.push('ls');

    expect(queue.state().text).toBe('ls');

    connection.exited$.next({ id: 't1', exitCode: 0 });

    expect(store.terminals()[0].exited).toBe(true);
    expect(queue.state().text).toBe('');
  });

  it('closing a terminal drops its queue and activates the neighbour', async () => {
    const { store, connection } = await setup([terminal('t1'), terminal('t2'), terminal('t3')]);
    store.activate('t2');
    const queue = store.inputQueue('t2');
    queue.push('ls');

    await store.close('t2');

    expect(connection.closes).toEqual(['t2']);
    expect(store.terminals().map((t) => t.id)).toEqual(['t1', 't3']);
    expect(store.activeId()).toBe('t3');
    expect(queue.state().text).toBe('');
    expect(store.inputQueue('t2')).not.toBe(queue);
  });

  it('gives each terminal only its own output', async () => {
    const { store, connection } = await setup([terminal('t1'), terminal('t2')]);
    const received: { seq: number; data: string }[] = [];
    store.output('t1').subscribe((chunk) => received.push(chunk));

    connection.output$.next({ id: 't2', seq: 1, data: 'for t2' });
    connection.output$.next({ id: 't1', seq: 2, data: 'for t1' });

    expect(received).toEqual([{ seq: 2, data: 'for t1' }]);
  });

  it('shows the lost connection after the automatic attempts and reattaches after a manual reconnect', async () => {
    const { fixture, store, connection } = await setup();

    connection.state.set('disconnected');
    fixture.detectChanges();

    expect(store.error()).toBe('No connection to the terminal.');

    let reattached = 0;
    store.reattach.subscribe(() => reattached++);
    const again = store.init();
    await tick();
    connection.lists[1].result.resolve([terminal('t1')]);
    await again;

    expect(connection.connects).toBe(2);
    expect(reattached).toBe(1);
    expect(store.error()).toBeNull();
  });

  it('refreshes the list and reattaches after an automatic reconnect', async () => {
    const { store, connection } = await setup();
    let reattached = 0;
    store.reattach.subscribe(() => reattached++);

    connection.reconnected$.next();
    await tick();

    expect(connection.lists).toHaveLength(2);
    expect(reattached).toBe(1);

    connection.lists[1].result.resolve([terminal('t1'), terminal('t4')]);
    await tick();

    expect(store.terminals().map((t) => t.id)).toEqual(['t1', 't4']);
  });

  describe('output order', () => {
    async function orderSetup() {
      const { store, connection } = await setup();
      const written: string[] = [];
      const order = new TerminalOutputOrder({
        reset: () => written.push('reset'),
        write: (data) => written.push(data)
      });
      store.output('t1').subscribe((chunk) => order.receive(chunk));
      const send = (seq: number, data: string) => connection.output$.next({ id: 't1', seq, data });
      return { order, written, send };
    }

    it('writes the snapshot, then the buffered chunks after its seq', async () => {
      const { order, written, send } = await orderSetup();

      order.beginAttach();
      send(3, 'in the snapshot');
      send(4, 'after the snapshot');

      expect(written).toEqual([]);

      order.completeAttach('screen', 3);

      expect(written).toEqual(['reset', 'screen', 'after the snapshot']);
    });

    it('skips a chunk the snapshot holds and writes the next one at once', async () => {
      const { order, written, send } = await orderSetup();
      order.beginAttach();
      order.completeAttach('s', 5);

      send(5, 'in the snapshot');

      expect(written).toEqual(['reset', 's']);

      send(6, 'next');

      expect(written).toEqual(['reset', 's', 'next']);
    });

    it('buffers after a lost connection until the next attach', async () => {
      const { order, written, send } = await orderSetup();
      order.beginAttach();
      order.completeAttach('s1', 5);

      order.detach();
      send(7, 'while detached');

      expect(written).toEqual(['reset', 's1']);

      order.beginAttach();
      send(8, 'during the attach');
      order.completeAttach('s2', 7);

      expect(written).toEqual(['reset', 's1', 'reset', 's2', 'during the attach']);
    });
  });
});
