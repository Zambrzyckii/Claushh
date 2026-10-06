import { Component, DOCUMENT, DestroyRef, ElementRef, computed, inject, input, output, signal } from '@angular/core';

import { WorkbenchState } from './workbench-state';

/** The step of an arrow key, in px. */
const STEP = 10;

/**
 * A panel's draggable edge, as VS Code's sash (docs/ARCHITECTURE.md, "Frontend" → "Layout"): a `role=separator` strip
 * over the panel's border. A drag with any pointer, the arrows (10 px), Home and End (the minimum and the maximum) give
 * a new size within `min` and `max`; a double-click asks for the size at start. While it is dragged,
 * `WorkbenchState.resizing` is true, so the terminals fit once at the end, and the whole page shows its cursor.
 */
@Component({
  selector: 'app-sash',
  template: '',
  styleUrl: './sash.scss',
  host: {
    role: 'separator',
    tabindex: '0',
    '[attr.aria-label]': 'label()',
    '[attr.aria-orientation]': 'orientation()',
    '[attr.aria-valuenow]': 'size()',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[class.sash--vertical]': "orientation() === 'vertical'",
    '[class.sash--horizontal]': "orientation() === 'horizontal'",
    '[class.sash--active]': 'active()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'endDrag()',
    '(pointercancel)': 'endDrag()',
    '(lostpointercapture)': 'endDrag()',
    '(dblclick)': 'reset.emit()',
    '(keydown)': 'onKeydown($event)'
  }
})
export class Sash {
  /** The edge of its panel: the side bar's right edge, the console's left edge, the bottom panel's top edge. */
  readonly edge = input.required<'right' | 'left' | 'top'>();
  readonly label = input.required<string>();
  readonly size = input.required<number>();
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  /** A new size, within `min` and `max`. */
  readonly resized = output<number>();
  /** A double-click: back to the size at start. */
  readonly reset = output<void>();

  private readonly state = inject(WorkbenchState);
  private readonly document = inject(DOCUMENT);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly orientation = computed(() => (this.edge() === 'top' ? 'horizontal' : 'vertical'));
  protected readonly active = signal(false);
  private drag: { pointerId: number; from: number; size: number } | null = null;

  constructor() {
    // A panel closed while its edge is dragged (Ctrl+Alt+B) ends the drag.
    inject(DestroyRef).onDestroy(() => this.endDrag());
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary || this.drag) {
      return;
    }
    event.preventDefault();
    this.element.setPointerCapture(event.pointerId);
    this.drag = { pointerId: event.pointerId, from: this.position(event), size: this.size() };
    this.active.set(true);
    this.state.resizing.set(true);
    this.document.documentElement.classList.add(`sash-dragging-${this.orientation()}`);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.drag?.pointerId === event.pointerId) {
      this.resizeTo(this.drag.size + this.sign() * (this.position(event) - this.drag.from));
    }
  }

  protected endDrag(): void {
    if (!this.drag) {
      return;
    }
    this.drag = null;
    this.active.set(false);
    this.state.resizing.set(false);
    this.document.documentElement.classList.remove(`sash-dragging-${this.orientation()}`);
  }

  /** The arrows move the edge the way they point; Home and End give the minimum and the maximum. */
  protected onKeydown(event: KeyboardEvent): void {
    const vertical = this.orientation() === 'vertical';
    let size: number;
    if (event.key === (vertical ? 'ArrowLeft' : 'ArrowUp')) {
      size = this.size() - this.sign() * STEP;
    } else if (event.key === (vertical ? 'ArrowRight' : 'ArrowDown')) {
      size = this.size() + this.sign() * STEP;
    } else if (event.key === 'Home') {
      size = this.min();
    } else if (event.key === 'End') {
      size = this.max();
    } else {
      return;
    }
    event.preventDefault();
    this.resizeTo(size);
  }

  /** 1 when moving right or down makes the panel bigger (the side bar), -1 when moving left or up does. */
  private sign(): number {
    return this.edge() === 'right' ? 1 : -1;
  }

  private position(event: PointerEvent): number {
    return this.orientation() === 'vertical' ? event.clientX : event.clientY;
  }

  private resizeTo(size: number): void {
    const next = Math.round(Math.min(this.max(), Math.max(this.min(), size)));
    if (next !== this.size()) {
      this.resized.emit(next);
    }
  }
}
