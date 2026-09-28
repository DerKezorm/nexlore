/** The context menu: keys, submenus, a click elsewhere, and the long press that opens it on a touch screen. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextMenu } from '../components/ContextMenu'
import { closingAll, menuTriggers, type MenuItem } from './menu'

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function show(items: MenuItem[], onClose = vi.fn()) {
  act(() => root!.render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />))
  return onClose
}

const key = (name: string) => act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })))
const focused = () => document.activeElement?.textContent

describe('the context menu', () => {
  it('starts on the first item it can run, walks with the arrows past what is off, and runs with Enter', () => {
    const ran: string[] = []
    const onClose = show([
      { label: 'Off', disabled: true, onSelect: () => ran.push('off') },
      { label: 'One', onSelect: () => ran.push('one') },
      'separator',
      { label: 'Two', onSelect: () => ran.push('two') },
    ])
    expect(focused()).toBe('One')
    key('ArrowDown')
    expect(focused()).toBe('Two')
    key('ArrowDown')
    expect(focused()).toBe('One')
    key('ArrowUp')
    expect(focused()).toBe('Two')
    act(() => (document.activeElement as HTMLButtonElement).click())
    expect(ran).toEqual(['two'])
    expect(onClose).toHaveBeenCalled()
  })

  it('closes with Escape and with a press anywhere else, not with a press inside', () => {
    const onClose = show([{ label: 'One', onSelect: () => undefined }])
    act(() => void document.querySelector('[role="menuitem"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(onClose).not.toHaveBeenCalled()
    act(() => void document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('opens a submenu with the arrow to the right, and leaves it with the arrow to the left', () => {
    const ran: string[] = []
    show([{ label: 'Format', items: [{ label: 'Bold', onSelect: () => ran.push('bold') }] }])
    expect(focused()).toContain('Format')
    key('ArrowRight')
    const sub = document.querySelector('[data-context-menu="sub"]')
    expect(sub?.textContent).toContain('Bold')
    ;(sub!.querySelector('[role="menuitem"]') as HTMLButtonElement).focus()
    key('ArrowLeft')
    expect(document.querySelector('[data-context-menu="sub"]')).toBeNull()
    expect(focused()).toContain('Format')
  })
})

describe('opening a menu', () => {
  const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }], preventDefault: vi.fn() }) as never

  it('opens with the right mouse button at the pointer, and with the menu key at the element', () => {
    const opened: [number, number][] = []
    const on = menuTriggers((x, y) => opened.push([x, y]))
    const preventDefault = vi.fn()
    on.onContextMenu({ clientX: 40, clientY: 50, preventDefault, stopPropagation: vi.fn() } as never)
    const element = { getBoundingClientRect: () => ({ left: 100, bottom: 30 }) }
    on.onContextMenu({ clientX: 0, clientY: 0, preventDefault, stopPropagation: vi.fn(), currentTarget: element } as never)
    expect(opened).toEqual([[40, 50], [116, 30]])
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it('opens after a long press where the finger is, not after a short one or when the finger moved', () => {
    vi.useFakeTimers()
    const opened: [number, number][] = []
    const on = menuTriggers((x, y) => opened.push([x, y]))
    on.onTouchStart(touch(20, 30))
    vi.advanceTimersByTime(300)
    on.onTouchEnd({ preventDefault: vi.fn() } as never)
    vi.advanceTimersByTime(1000)
    expect(opened).toEqual([])

    on.onTouchStart(touch(20, 30))
    on.onTouchMove(touch(20, 60))
    vi.advanceTimersByTime(1000)
    expect(opened).toEqual([])

    on.onTouchStart(touch(20, 30))
    on.onTouchMove(touch(24, 33))
    vi.advanceTimersByTime(600)
    expect(opened).toEqual([[20, 30]])
    // The click that follows the long press is swallowed.
    const end = { preventDefault: vi.fn() }
    on.onTouchEnd(end as never)
    expect(end.preventDefault).toHaveBeenCalled()
  })
})

describe('a submenu item', () => {
  it('closes the whole menu before it runs, not only its own part', () => {
    const order: string[] = []
    const [group] = closingAll([{ label: 'Format', items: [{ label: 'Bold', onSelect: () => order.push('bold') }] }], () => order.push('closed'))
    ;((group as { items: { onSelect: () => void }[] }).items[0]).onSelect()
    expect(order).toEqual(['closed', 'bold'])
  })
})
