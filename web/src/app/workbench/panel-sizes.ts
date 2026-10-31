/**
 * The resizable panels' sizes (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the size at start and the minimum of the
 * side bar, the console and the bottom panel, and their fit to the window. The editor keeps at least EDITOR_MIN_WIDTH ×
 * EDITOR_MIN_HEIGHT; a window too narrow for the chosen widths takes the room from the console first, then from the
 * side bar, each down to its minimum. The chosen sizes stay as they are, so a wider window gives them back.
 */

export const SIDE_BAR = { initial: 240, min: 170 };
export const CONSOLE = { initial: 420, min: 320 };
export const PANEL = { initial: 232, min: 120 };
export const EDITOR_MIN_WIDTH = 240;
export const EDITOR_MIN_HEIGHT = 120;

export interface PanelSizes {
  sideBar: number;
  console: number;
  panel: number;
  sideBarMax: number;
  consoleMax: number;
  panelMax: number;
}

/**
 * `chosen`: the sizes in WorkbenchState; `open`: which side columns take room; `width` and `height`: the measured width
 * of `.main` and height of `.center`, 0 while unmeasured (before the first layout, and always in jsdom, which has no
 * ResizeObserver): then the chosen sizes apply as they are and each maximum is the size itself.
 */
export function fitPanels(
  chosen: { sideBar: number; console: number; panel: number },
  open: { sideBar: boolean; console: boolean },
  width: number,
  height: number
): PanelSizes {
  let sideBar = chosen.sideBar;
  let consoleWidth = chosen.console;
  let sideBarMax = sideBar;
  let consoleMax = consoleWidth;
  if (width > 0) {
    let overflow = (open.sideBar ? sideBar : 0) + (open.console ? consoleWidth : 0) + EDITOR_MIN_WIDTH - width;
    if (overflow > 0 && open.console) {
      const cut = Math.min(overflow, consoleWidth - CONSOLE.min);
      consoleWidth -= cut;
      overflow -= cut;
    }
    if (overflow > 0 && open.sideBar) {
      sideBar -= Math.min(overflow, sideBar - SIDE_BAR.min);
    }
    sideBarMax = Math.max(SIDE_BAR.min, width - (open.console ? consoleWidth : 0) - EDITOR_MIN_WIDTH);
    consoleMax = Math.max(CONSOLE.min, width - (open.sideBar ? sideBar : 0) - EDITOR_MIN_WIDTH);
  }
  const panelMax = height > 0 ? Math.max(PANEL.min, height - EDITOR_MIN_HEIGHT) : chosen.panel;
  return { sideBar, console: consoleWidth, panel: Math.min(chosen.panel, panelMax), sideBarMax, consoleMax, panelMax };
}
