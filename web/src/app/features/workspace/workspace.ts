import { Component, signal } from '@angular/core';

/**
 * Main view after login (layout as in the mockup):
 * file explorer | editor | console, below it the Workspace/Terminal panel, at the bottom the status bar.
 *
 * For now this is only a layout skeleton. The individual areas will be extracted
 * into separate components in later stages (see docs/PLAN.md, "Stages").
 */
@Component({
  selector: 'app-workspace',
  templateUrl: './workspace.html',
  styleUrl: './workspace.scss'
})
export class Workspace {
  protected readonly consoleOpen = signal(true);
  protected readonly bottomOpen = signal(true);
  protected readonly bottomTab = signal<'workspace' | 'terminal'>('workspace');

  protected toggleConsole(): void {
    this.consoleOpen.update((open) => !open);
  }

  protected toggleBottom(): void {
    this.bottomOpen.update((open) => !open);
  }
}
