import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { ProjectContext } from '../../core/project/project-context';
import { ConnectionState, ConsoleConnection } from '../../core/realtime/console-connection';
import { ConsoleEvent, ConversationSnapshot, SendPromptRequest } from '../../core/realtime/console-protocol';
import { EditorStore } from '../editor/editor-store';
import { ConsolePanel } from './console-panel';
import { ConsoleStore } from './console-store';

/**
 * Integration: real ConsolePanel + ConsoleStore + ProjectContext + EditorStore.
 * Only the network boundary is replaced: the SignalR connection (FakeConnection) and HTTP (HttpTestingController).
 */

class FakeConnection {
  /** Conversation returned by GetConversation. Set before the component is created. */
  static nextSnapshot: ConversationSnapshot = { conversationId: null, events: [] };

  readonly state = signal<ConnectionState>('disconnected');
  readonly events$ = new Subject<ConsoleEvent>();
  readonly events = this.events$.asObservable();
  readonly reconnected = new Subject<void>().asObservable();
  snapshot = FakeConnection.nextSnapshot;
  readonly sent: SendPromptRequest[] = [];
  readonly answers: unknown[] = [];

  async connect() {
    this.state.set('connected');
    return true;
  }
  async getConversation() {
    return this.snapshot;
  }
  async startConversation(projectPath: string) {
    this.emit({ type: 'conversation', conversationId: 'c-new', projectPath, startedAt: '2026-09-28T10:00:00Z' });
    return 'c-new';
  }
  async sendPrompt(request: SendPromptRequest) {
    this.sent.push(request);
  }
  async answerPermission(...args: unknown[]) {
    this.answers.push(args);
  }
  async interrupt() {}
  emit(event: ConsoleEvent) {
    this.events$.next(event);
  }
}

@Component({
  imports: [ConsolePanel],
  providers: [ProjectContext, EditorStore, ConsoleStore, { provide: ConsoleConnection, useClass: FakeConnection }],
  template: '<app-console-panel />'
})
class Host {
  readonly editor = inject(EditorStore);
  readonly connection = inject(ConsoleConnection) as unknown as FakeConnection;
}

describe('Console (integration)', () => {
  async function setup(snapshot?: ConversationSnapshot) {
    FakeConnection.nextSnapshot = snapshot ?? { conversationId: null, events: [] };
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const fixture = TestBed.createComponent(Host);
    const host = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    // Several rounds: some updates (e.g. ngModel) reach the view only in the next cycle.
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve));
        await fixture.whenStable();
        fixture.detectChanges();
      }
    };
    await settle();
    return { fixture, host, root, settle, http: TestBed.inject(HttpTestingController) };
  }

  const text = (root: HTMLElement) => root.querySelector('.log')!.textContent!.replace(/\s+/g, ' ');

  it('replays the saved conversation after loading', async () => {
    const { root } = await setup({
      conversationId: 'c1',
      events: [
        { type: 'conversation', conversationId: 'c1', projectPath: '', startedAt: '2026-09-28T10:00:00Z' },
        { type: 'prompt', conversationId: 'c1', text: 'napraw test' },
        { type: 'step', conversationId: 'c1', stepId: 's1', kind: 'edit', target: 'a.c', added: 2, removed: 1 },
        { type: 'step-output', conversationId: 'c1', stepId: 's1', text: 'ok', isError: false },
        { type: 'text', conversationId: 'c1', messageId: 'm', delta: 'Gotowe' },
        { type: 'text', conversationId: 'c1', messageId: 'm', delta: '.' },
        { type: 'status', conversationId: 'c1', state: 'idle' }
      ]
    });
    expect(text(root)).toContain('> napraw test');
    expect(text(root)).toContain('edycja a.c +2 −1');
    expect(text(root)).toContain('ok');
    expect(text(root)).toContain('Gotowe.');
  });

  it('starts a conversation on the first prompt and sends the selected options', async () => {
    const { host, root, settle } = await setup();
    const textarea = root.querySelector('textarea')!;
    const selects = root.querySelectorAll('select');
    selects[0].value = selects[0].options[2].value;
    selects[0].dispatchEvent(new Event('change'));
    selects[2].value = selects[2].options[2].value;
    selects[2].dispatchEvent(new Event('change'));
    textarea.value = '  napisz testy  ';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();

    expect(host.connection.sent).toEqual([
      { conversationId: 'c-new', text: 'napisz testy', model: 'haiku', effort: 'medium', mode: 'plan' }
    ]);
    expect(textarea.value).toBe('');
    expect(text(root)).toContain('sesja · rozpoczęta');
    expect(text(root)).toContain('pracuje…');
  });

  it('ignores events from other conversations', async () => {
    const { host, root, settle } = await setup({ conversationId: 'c1', events: [] });
    host.connection.emit({ type: 'prompt', conversationId: 'other', text: 'obce' });
    host.connection.emit({ type: 'prompt', conversationId: 'c1', text: 'moje' });
    await settle();
    expect(text(root)).toContain('> moje');
    expect(text(root)).not.toContain('obce');
  });

  it('answers a permission request and shows the decision', async () => {
    const { host, root, settle } = await setup({ conversationId: 'c1', events: [] });
    host.connection.emit({ type: 'permission', conversationId: 'c1', requestId: 'r1', description: 'rm -rf build' });
    await settle();
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.permission button'));
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['tak', 'tak, zawsze', 'nie']);
    buttons[2].click();
    await settle();
    expect(host.connection.answers).toEqual([['c1', 'r1', 'deny']]);

    host.connection.emit({ type: 'permission-resolved', conversationId: 'c1', requestId: 'r1', decision: 'deny' });
    await settle();
    expect(root.querySelector('.permission')).toBeNull();
    expect(text(root)).toContain('odmówiono: rm -rf build');
  });

  it('reloads a clean open file when the console changes it', async () => {
    const { host, settle, http } = await setup({ conversationId: 'c1', events: [] });
    const opening = host.editor.open('src/a.c');
    http.expectOne((r) => r.url === '/api/files/content').flush({ path: 'src/a.c', content: 'old', version: 'v1' });
    await opening;

    host.connection.emit({ type: 'files-changed', conversationId: 'c1', paths: ['src/a.c'] });
    await settle();
    http.expectOne((r) => r.url === '/api/files/content').flush({ path: 'src/a.c', content: 'new', version: 'v2' });
    await settle();
    expect(host.editor.active()).toMatchObject({ value: 'new', version: 'v2' });
  });

  it('only flags a file with unsaved changes when the console changes it', async () => {
    const { host, settle, http } = await setup({ conversationId: 'c1', events: [] });
    const opening = host.editor.open('src/a.c');
    http.expectOne((r) => r.url === '/api/files/content').flush({ path: 'src/a.c', content: 'old', version: 'v1' });
    await opening;
    host.editor.updateValue('src/a.c', 'mine');

    host.connection.emit({ type: 'files-changed', conversationId: 'c1', paths: ['src/a.c'] });
    await settle();
    http.expectNone((r) => r.url === '/api/files/content');
    expect(host.editor.active()).toMatchObject({ value: 'mine', changedOnDisk: true });
  });
});
