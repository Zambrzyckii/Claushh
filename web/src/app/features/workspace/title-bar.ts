import { Component, HostListener, computed, inject, input, output, signal } from '@angular/core';

import { AuthService } from '../../core/auth/auth.service';
import { SessionTimer } from '../../core/auth/session-timer';
import { DeviceLayout } from '../../core/browser/device-layout';
import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { WorkspacesStore } from '../workspaces/workspaces-store';
import { WorkbenchState } from './workbench-state';

/**
 * The top bar of both layouts (docs/ARCHITECTURE.md, "Frontend" → "Layout"). Desktop: VS Code's title bar with the
 * command centre (the open repository and its branch; a click shows Source Control), the toggles of the side bar, the
 * panel and the console, and the account menu. Phone: the repository button (the drawer on Source Control), the countdown
 * with "Extend" and the same menu behind a kebab. Workspace handles Security, Log out and the repository button.
 */
@Component({
  selector: 'app-title-bar',
  templateUrl: './title-bar.html',
  styleUrl: './title-bar.scss'
})
export class TitleBar {
  protected readonly layout = inject(DeviceLayout);
  protected readonly state = inject(WorkbenchState);
  protected readonly project = inject(ProjectContext);
  protected readonly repoStatus = inject(RepoStatusStore);
  protected readonly sessionTimer = inject(SessionTimer);
  private readonly workspaces = inject(WorkspacesStore);
  protected readonly user = inject(AuthService).user;

  readonly loggingOut = input(false);
  readonly security = output<void>();
  readonly logout = output<void>();
  readonly repository = output<void>();

  protected readonly menuOpen = signal(false);
  /** The open repository's workspace by its display name, e.g. "Studia". */
  protected readonly workspaceName = computed(
    () => this.workspaces.openWorkspace()?.name ?? this.project.path().split('/')[0]
  );

  protected openSecurity(): void {
    this.menuOpen.set(false);
    this.security.emit();
  }

  protected logOut(): void {
    this.menuOpen.set(false);
    this.logout.emit();
  }

  @HostListener('document:keydown.escape')
  protected closeMenu(): void {
    this.menuOpen.set(false);
  }
}
