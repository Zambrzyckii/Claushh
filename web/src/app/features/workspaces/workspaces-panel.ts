import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';

import { RepoSummary } from '../../core/api/workspaces-api';
import { DeviceLayout } from '../../core/browser/device-layout';
import { ProjectContext } from '../../core/project/project-context';
import { countLabel, timeAgo } from '../../core/text/format';
import { WorkspacesStore } from './workspaces-store';

/**
 * The "Workspace" tab in the bottom panel (on a phone, the Workspace sheet with repository cards): workspaces on the
 * left, on the right a table of repositories of the selected workspace (branch, state, last commit, remotes) with
 * Open / Pull / Push actions, cloning below.
 * State and operations: WorkspacesStore.
 */
@Component({
  selector: 'app-workspaces-panel',
  host: { '[class.phone]': 'layout.phone()' },
  templateUrl: './workspaces-panel.html',
  styleUrl: './workspaces-panel.scss'
})
export class WorkspacesPanel {
  protected readonly store = inject(WorkspacesStore);
  protected readonly project = inject(ProjectContext);
  protected readonly layout = inject(DeviceLayout);

  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected readonly createBusy = signal(false);
  protected readonly cloning = signal(false);
  protected readonly cloneError = signal<string | null>(null);
  protected readonly cloneBusy = signal(false);

  private readonly workspaceName = viewChild<ElementRef<HTMLInputElement>>('workspaceName');
  private readonly cloneUrl = viewChild<ElementRef<HTMLInputElement>>('cloneUrl');

  protected state(repo: RepoSummary): string {
    return repo.changes === 0 ? 'clean' : countLabel(repo.changes, 'change', 'changes');
  }

  protected remote(repo: RepoSummary): string {
    if (!repo.upstream) {
      return 'none';
    }
    const remote = repo.upstream.split('/', 1)[0];
    const arrows = [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' ');
    return arrows ? `${remote} ${arrows}` : remote;
  }

  protected when(repo: RepoSummary): string {
    return repo.lastCommit ? timeAgo(repo.lastCommit.date) : '';
  }

  protected isOpen(repo: RepoSummary): boolean {
    return repo.path === this.project.path();
  }

  protected repoCount(count: number): string {
    return countLabel(count, 'repo', 'repos');
  }

  protected startCreating(): void {
    this.creating.set(true);
    this.createError.set(null);
    queueMicrotask(() => this.workspaceName()?.nativeElement.focus());
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const input = this.workspaceName()?.nativeElement;
    if (!input || this.createBusy()) {
      return;
    }
    this.createBusy.set(true);
    const error = await this.store.createWorkspace(input.value);
    this.createBusy.set(false);
    this.createError.set(error);
    if (!error) {
      this.creating.set(false);
    }
  }

  protected startCloning(): void {
    this.cloning.set(true);
    this.cloneError.set(null);
    queueMicrotask(() => this.cloneUrl()?.nativeElement.focus());
  }

  protected async clone(event: Event): Promise<void> {
    event.preventDefault();
    const input = this.cloneUrl()?.nativeElement;
    if (!input || this.cloneBusy()) {
      return;
    }
    this.cloneBusy.set(true);
    const error = await this.store.clone(input.value);
    this.cloneBusy.set(false);
    this.cloneError.set(error);
    if (!error) {
      this.cloning.set(false);
    }
  }

  protected cancel(form: 'create' | 'clone'): void {
    if (form === 'create') {
      this.creating.set(false);
      this.createError.set(null);
    } else {
      this.cloning.set(false);
      this.cloneError.set(null);
    }
  }
}
