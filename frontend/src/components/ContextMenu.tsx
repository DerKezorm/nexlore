/**
 * A menu at the pointer: the right mouse button, or a long press on a touch screen (`menuTriggers`). Kept inside the
 * window, driven by the keys a menu has (arrows, Enter, Escape; arrow right opens a submenu), closed by a click
 * elsewhere, by scrolling by hand (wheel, finger) and by leaving the window. A scroll the page does by itself (the
 * sidebar reading a folder again, showing the open note) leaves it open: it came right after a right click at times.
 *
 * Items keep the focus where it was when pressed (the editor keeps its selection), then the menu closes and the item
 * runs.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import type { MenuAction, MenuGroup, MenuItem } from '../lib/menu'
import { Symbol } from './Symbol'

const isAction = (item: MenuItem): item is MenuAction => item !== 'separator' && 'onSelect' in item
const isGroup = (item: MenuItem): item is MenuGroup => item !== 'separator' && 'items' in item

export function ContextMenu({ x, y, items, onClose, sub = false }: { x: number; y: number; items: MenuItem[]; onClose: () => void; sub?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: x, top: y })
  const [openGroup, setOpenGroup] = useState<{ index: number; x: number; y: number } | null>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  // Inside the window: a menu near the right or bottom edge opens to the left or upwards.
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - width - 4))
    const top = Math.max(4, y + height > window.innerHeight - 4 ? Math.max(4, y - height) : y)
    setPlace({ left: sub && x + width > window.innerWidth - 4 ? Math.max(4, x - width * 2) : left, top })
  }, [x, y, sub])

  useEffect(() => {
    if (!sub) buttons.current.find((button) => button && !button.disabled)?.focus({ preventScroll: true })
  }, [sub])

  useEffect(() => {
    if (sub) return
    const away = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-context-menu]')) onClose()
    }
    const leave = () => onClose()
    document.addEventListener('pointerdown', away, true)
    const byHand = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-context-menu]')) onClose()
    }
    window.addEventListener('wheel', byHand, { capture: true, passive: true })
    window.addEventListener('touchmove', byHand, { capture: true, passive: true })
    window.addEventListener('resize', leave)
    window.addEventListener('blur', leave)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('wheel', byHand, true)
      window.removeEventListener('touchmove', byHand, true)
      window.removeEventListener('resize', leave)
      window.removeEventListener('blur', leave)
    }
  }, [onClose, sub])

  const openSub = (index: number) => {
    const rect = buttons.current[index]?.getBoundingClientRect()
    if (rect) setOpenGroup({ index, x: rect.right - 4, y: rect.top - 5 })
  }

  const onKey = (event: KeyboardEvent) => {
    const enabled = buttons.current.map((button, index) => (button && !button.disabled ? index : -1)).filter((index) => index >= 0)
    const at = enabled.indexOf(buttons.current.indexOf(document.activeElement as HTMLButtonElement))
    const move = (step: number) => buttons.current[enabled[(at + step + enabled.length) % enabled.length]]?.focus()
    if (event.key === 'ArrowDown') move(1)
    else if (event.key === 'ArrowUp') move(at < 0 ? 0 : -1)
    else if (event.key === 'Escape' || (sub && event.key === 'ArrowLeft')) onClose()
    else if (event.key === 'ArrowRight' && at >= 0 && isGroup(items[enabled[at]])) openSub(enabled[at])
    else if (event.key === 'Tab') onClose()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const menu = (
    <div
      ref={box}
      role="menu"
      data-context-menu={sub ? 'sub' : 'main'}
      onKeyDown={onKey}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 min-w-52 max-w-[calc(100vw-8px)] rounded-xl border border-ink-700 bg-ink-900 py-1 text-sm text-mist-200 shadow-xl shadow-black/30"
      style={{ left: place.left, top: place.top }}
    >
      {items.map((item, index) => {
        if (item === 'separator') return <div key={index} role="separator" className="my-1 border-t border-ink-700" />
        const group = isGroup(item)
        return (
          <button
            key={index}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role="menuitem"
            aria-haspopup={group ? 'menu' : undefined}
            aria-expanded={group ? openGroup?.index === index : undefined}
            disabled={isAction(item) ? item.disabled : false}
            // The editor keeps its selection: the press does not take the focus away from it.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => (group ? openSub(index) : setOpenGroup(null))}
            onClick={() => {
              if (group) return openSub(index)
              if (!isAction(item) || item.disabled) return
              onClose()
              item.onSelect()
            }}
            className={
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left outline-none hover:bg-ink-850 focus-visible:bg-ink-850 disabled:cursor-default disabled:opacity-40 ' +
              (isAction(item) && item.danger ? 'text-bad-500' : '')
            }
          >
            <span className="grid h-4 w-4 shrink-0 place-items-center text-mist-500">{item.symbol && <Symbol name={item.symbol} className="h-4 w-4" />}</span>
            <span className="flex-1 truncate">{item.label}</span>
            {isAction(item) && item.hint && <kbd className="text-[11px] text-mist-600">{item.hint}</kbd>}
            {group && <Symbol name="chevronRight" className="h-3.5 w-3.5 text-mist-500" />}
          </button>
        )
      })}
      {openGroup && isGroup(items[openGroup.index]) && (
        <ContextMenu
          sub
          x={openGroup.x}
          y={openGroup.y}
          items={(items[openGroup.index] as MenuGroup).items}
          onClose={() => {
            setOpenGroup(null)
            buttons.current[openGroup.index]?.focus()
          }}
        />
      )}
    </div>
  )
  return sub ? menu : createPortal(menu, document.body)
}
