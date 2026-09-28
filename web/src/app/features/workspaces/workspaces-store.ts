import { DOCUMENT, DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, firstValueFrom, fromEvent, merge } from 'rxjs';

import { ApiError, toApiError } from '../../core/api/api-error';
import { GitApi } from '../../core/api/git-api';
import { RepoSummary, WorkspaceInfo, WorkspacesApi } from '../../core/api/workspaces-api';
import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { validateCloneUrl, validateWorkspaceName } from './validation';

export type RepoOperation = 'pull' | 'push';

export interface RepoMessage {
  text: string;
  error: boolean;
}

/**
 * State of the Workspace panel: list of workspaces, repositories of the selected workspace, git operations (pull, push),
 * creating a workspace and cloning. Opening a repository sets ProjectContext.
 *
 * The repository list refreshes after operations, after file changes (console, save) and after returning to the tab.
 * Background refresh does not clear the visible data. Provided in the Workspace component.
 */
@Injectable()
export class WorkspacesStore {
  private readonly api = inject(WorkspacesApi);
  private readonly git = inject(GitApi);
  private readonly project = inject(ProjectContext);
  private readonly repoStatus = inject(RepoStatusStore);

  private readonly workspacesSignal = signal<readonly WorkspaceInfo[] | null>(null);
  private readonly selectedSignal = signal<string | null>(null);
  private readonly reposSignal = signal<readonly RepoSummary[] | null>(null);
  private readonly busySignal = signal<ReadonlyMap<string, RepoOperation>>(new Map());
  private readonly messagesSignal = signal<ReadonlyMap<string, RepoMessage>>(new Map());
  private reposRequest = 0;

  readonly workspaces = this.workspacesSignal.asReadonly();
  readonly selected = this.selectedSignal.asReadonly();
  readonly repos = this.reposSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly messages = this.messagesSignal.asReadonly();
  readonly listError = signal<string | null>(null);
  readonly reposError = signal<string | null>(null);

  readonly selectedWorkspace = computed(() => this.workspacesSignal()?.find((w) => w.path === this.selectedSignal()) ?? null);

  /** Workspace of the open repository (for the path in the top bar). */
  readonly openWorkspace = computed(() => {
    const repo = this.project.path();
    const top = repo.split('/', 1)[0];
    return repo === '' ? null : (this.workspacesSignal()?.find((w) => w.path === top) ?? null);
  });

  constructor() {
    void this.load();
    const document = inject(DOCUMENT);
    merge(this.project.filesChanged, this.project.filesSaved, fromEvent(document, 'visibilitychange'))
      .pipe(debounceTime(500), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => {
        if (document.visibilityState !== 'hidden') {
          void this.refreshRepos();
        }
      });
  }

  async load(): Promise<void> {
    this.listError.set(null);
    try {
      const workspaces = await firstValueFrom(this.api.list());
      this.workspacesSignal.set(workspaces);
      if (!workspaces.some((w) => w.path === this.selectedSignal())) {
        const top = this.project.path().split('/', 1)[0];
        const initial = workspaces.find((w) => w.path === top) ?? workspaces[0] ?? null;
        this.selectedSignal.set(initial?.path ?? null);
        this.reposSignal.set(null);
      }
      await this.refreshRepos();
    } catch (error) {
      this.listError.set(message(error, 'Nie udało się wczytać workspace\'ów.'));
    }
  }

  select(path: string): void {
    if (path === this.selectedSignal()) {
      return;
    }
    this.selectedSignal.set(path);
    this.reposSignal.set(null);
    this.messagesSignal.set(new Map());
    void this.refreshRepos();
  }

  async refreshRepos(): Promise<void> {
    const workspace = this.selectedSignal();
    const request = ++this.reposRequest;
    if (!workspace) {
      this.reposSignal.set([]);
      return;
    }
    try {
      const repos = await firstValueFrom(this.api.repos(workspace));
      if (request === this.reposRequest) {
        this.reposSignal.set(repos);
        this.reposError.set(null);
        this.updateCount(workspace, repos.length);
      }
    } catch (error) {
      if (request === this.reposRequest) {
        this.reposError.set(message(error, 'Nie udało się wczytać repozytoriów.'));
      }
    }
  }

  open(repo: RepoSummary): Promise<boolean> {
    return this.project.open(repo.path);
  }

  /** Creates a workspace and selects it right away. Returns an error message or `null`. */
  async createWorkspace(name: string): Promise<string | null> {
    const invalid = validateWorkspaceName(name);
    if (invalid) {
      return invalid;
    }
    try {
      const created = await firstValueFrom(this.api.create(name.trim()));
      this.workspacesSignal.update((list) => [...(list ?? []).filter((w) => w.path !== created.path), created]);
      this.select(created.path);
      this.project.announceFilesChanged([created.path]); // new directory in the explorer
      return null;
    } catch (error) {
      const e = toApiError(error);
      return e.kind === 'conflict' ? 'Workspace o tej nazwie już istnieje.' : message(e, 'Nie udało się utworzyć workspace\'u.');
    }
  }

  /** Clones a repository into the selected workspace. Returns an error message or `null`. */
  async clone(url: string): Promise<string | null> {
    const workspace = this.selectedSignal();
    if (!workspace) {
      return 'Najpierw wybierz workspace.';
    }
    const invalid = validateCloneUrl(url);
    if (invalid) {
      return invalid;
    }
    try {
      const repo = await firstValueFrom(this.api.clone(workspace, url.trim()));
      if (this.selectedSignal() === workspace) {
        this.reposSignal.update((repos) => [...(repos ?? []).filter((r) => r.path !== repo.path), repo]);
        this.updateCount(workspace, this.reposSignal()?.length ?? 0);
      }
      this.project.announceFilesChanged([repo.path]); // new directory in the explorer
      return null;
    } catch (error) {
      const e = toApiError(error);
      switch (e.kind) {
        case 'conflict':
          return 'Repozytorium o tej nazwie już jest w tym workspace.';
        case 'remote':
          return withDetail('Nie udało się sklonować.', e.detail);
        default:
          return message(e, 'Nie udało się sklonować.');
      }
    }
  }

  async pull(repo: RepoSummary): Promise<void> {
    await this.run(repo, 'pull', async () => {
      const result = await firstValueFrom(this.git.pull(repo.path));
      this.project.announceFilesChanged(result.changedPaths);
      return result.message || 'Pobrano zmiany.';
    });
  }

  async push(repo: RepoSummary): Promise<void> {
    await this.run(repo, 'push', async () => (await firstValueFrom(this.git.push(repo.path))).message || 'Wypchnięto.');
  }

  private async run(repo: RepoSummary, operation: RepoOperation, action: () => Promise<string>): Promise<void> {
    if (this.busySignal().has(repo.path)) {
      return;
    }
    this.busySignal.update((map) => new Map(map).set(repo.path, operation));
    this.setMessage(repo.path, null);
    try {
      this.setMessage(repo.path, { text: await action(), error: false });
    } catch (error) {
      this.setMessage(repo.path, { text: gitErrorMessage(operation, toApiError(error)), error: true });
    } finally {
      this.busySignal.update((map) => {
        const next = new Map(map);
        next.delete(repo.path);
        return next;
      });
      await this.refreshRepos();
      if (repo.path === this.project.path()) {
        await this.repoStatus.refresh();
      }
    }
  }

  private setMessage(path: string, value: RepoMessage | null): void {
    this.messagesSignal.update((map) => {
      const next = new Map(map);
      if (value) {
        next.set(path, value);
      } else {
        next.delete(path);
      }
      return next;
    });
  }

  private updateCount(workspace: string, count: number): void {
    this.workspacesSignal.update((list) => list?.map((w) => (w.path === workspace && w.repoCount !== count ? { ...w, repoCount: count } : w)) ?? list);
  }
}

function gitErrorMessage(operation: RepoOperation, error: ApiError): string {
  const name = operation === 'pull' ? 'Pull' : 'Push';
  switch (error.kind) {
    case 'conflict':
      return withDetail(
        operation === 'pull'
          ? 'Pull odrzucony: gałęzie się rozeszły albo masz zmiany, które by się nadpisały. Rozwiąż to w terminalu lub konsoli.'
          : 'Push odrzucony: na zdalnym repozytorium są nowsze zmiany. Najpierw zrób Pull.',
        error.detail
      );
    case 'remote':
      return withDetail(`${name}: błąd zdalnego repozytorium.`, error.detail);
    case 'not-found':
      return `${name}: nie znaleziono repozytorium.`;
    case 'invalid':
      return withDetail(`${name}: nieprawidłowe żądanie.`, error.detail);
    case 'network':
      return `${name}: brak połączenia z serwerem.`;
    case 'server':
      return withDetail(`${name}: błąd serwera.`, error.detail);
  }
}

function message(error: unknown, fallback: string): string {
  const e = toApiError(error);
  return e.kind === 'network' ? 'Brak połączenia z serwerem.' : withDetail(fallback, e.detail);
}

function withDetail(text: string, detail: string | null): string {
  return detail ? `${text}\n${detail}` : text;
}
