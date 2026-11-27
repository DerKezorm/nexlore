/**
 * Where a menu at the pointer stands (`ContextMenu`): inside the window. Near the right edge it opens to the left (a
 * submenu beside its parent on the other side), near the bottom upwards; never above 8 px from the top. A menu higher
 * than the window stands 8 px from the top and scrolls inside (`MENU_MAX_HEIGHT`), so no entry is out of reach.
 */

/** Room kept to the top and the bottom of the window. */
export const MENU_EDGE = 8
/** The highest a menu may be: the window less the room above and below; what is more scrolls. */
export const MENU_MAX_HEIGHT = `calc(100dvh - ${MENU_EDGE * 2}px)`

export type MenuPlaceInput = { x: number; y: number; width: number; height: number; viewWidth: number; viewHeight: number; sub?: boolean }

export function menuPlace({ x, y, width, height, viewWidth, viewHeight, sub = false }: MenuPlaceInput): { left: number; top: number } {
  const left = sub && x + width > viewWidth - 4 ? Math.max(4, x - width * 2) : Math.max(4, Math.min(x, viewWidth - width - 4))
  // Below the pointer where it fits, else above it, never off the bottom; and never above 8 px from the top, which is
  // where a menu higher than the window stands (it scrolls beyond its highest).
  const wanted = y + height <= viewHeight - MENU_EDGE ? y : y - height
  const top = Math.max(MENU_EDGE, Math.min(wanted, viewHeight - MENU_EDGE - height))
  return { left, top }
}
