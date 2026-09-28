/**
 * Context menus (components/ContextMenu.tsx): what an item is, the hook that holds an open menu, and the handlers that
 * open one on an element, with the right mouse button or a long press on a touch screen.
 */
import { useCallback, useState, type MouseEvent, type TouchEvent } from 'react'

import { ContextMenu } from '../components/ContextMenu'
import type { SymbolName } from '../components/Symbol'

export type MenuAction = { label: string; symbol?: SymbolName; danger?: boolean; disabled?: boolean; hint?: string; onSelect: () => void }
export type MenuGroup = { label: string; symbol?: SymbolName; items: MenuItem[] }
export type MenuItem = MenuAction | MenuGroup | 'separator'

type Place = { x: number; y: number; items: MenuItem[] }

/** A menu to open at a point; `element` goes somewhere in the page (it renders into the body). */
export function useContextMenu() {
  const [menu, setMenu] = useState<Place | null>(null)
  // An item of a submenu closes the whole menu, not only its own part.
  const open = useCallback(
    (x: number, y: number, items: MenuItem[]) => setMenu(items.length ? { x, y, items: closingAll(items, () => setMenu(null)) } : null),
    [],
  )
  const close = useCallback(() => setMenu(null), [])
  const element = menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} /> : null
  return { open, close, element, isOpen: menu !== null }
}

const LONG_PRESS_MS = 550
const MOVE_TOLERANCE = 10

// One finger presses at a time: the pending long press lives here, not in each row (rows are drawn in a loop).
let pressing: { timer: number; x: number; y: number; fired: boolean } | null = null

/**
 * The handlers that open a menu on an element: the right mouse button, and a long press on a touch screen (iPhones
 * send no `contextmenu` for it). After a long press the click that follows is swallowed.
 */
export function menuTriggers(onOpen: (x: number, y: number) => void) {
  const cancel = () => {
    if (pressing) window.clearTimeout(pressing.timer)
  }
  return {
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      pressing = null
      // From the keyboard (the menu key, Shift+F10) there is no pointer: the menu opens at the element.
      if (event.clientX === 0 && event.clientY === 0) {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
        onOpen(rect.left + 16, rect.bottom)
      } else onOpen(event.clientX, event.clientY)
    },
    onTouchStart: (event: TouchEvent) => {
      cancel()
      const touch = event.touches[0]
      if (!touch || event.touches.length > 1) {
        pressing = null
        return
      }
      const state = { timer: 0, x: touch.clientX, y: touch.clientY, fired: false }
      state.timer = window.setTimeout(() => {
        state.fired = true
        onOpen(state.x, state.y)
      }, LONG_PRESS_MS)
      pressing = state
    },
    onTouchMove: (event: TouchEvent) => {
      const touch = event.touches[0]
      if (pressing && touch && Math.hypot(touch.clientX - pressing.x, touch.clientY - pressing.y) > MOVE_TOLERANCE) {
        cancel()
        pressing = null
      }
    },
    onTouchEnd: (event: TouchEvent) => {
      cancel()
      if (pressing?.fired) event.preventDefault()
      pressing = null
    },
    onTouchCancel: () => {
      cancel()
      pressing = null
    },
  }
}

const isGroup = (item: MenuItem): item is MenuGroup => item !== 'separator' && 'items' in item

/** Closes a whole menu from a submenu item: the item's own `onSelect` runs after. */
export function closingAll(items: MenuItem[], close: () => void): MenuItem[] {
  return items.map((item) =>
    item === 'separator' ? item : isGroup(item) ? { ...item, items: closingAll(item.items, close) } : { ...item, onSelect: () => { close(); item.onSelect() } },
  )
}
