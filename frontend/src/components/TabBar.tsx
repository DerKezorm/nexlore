/**
 * The row of open notes above the note (`lib/tabs.ts`), from two notes on. A click shows a tab, the cross or the middle
 * button closes it, dragging puts it elsewhere in the row; the right button (a long press on a touch screen) pins it
 * or closes the others. At the end of the row a list of all of them, for a narrow screen where the row scrolls.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { menuTriggers, useContextMenu } from '../lib/menu'
import { closeOtherTabs, closeTab, followTab, forgetTabs, moveTab, pinTab, readPinned, readTabs, TABS_EVENT, type Tabs } from '../lib/tabs'
import { FORGET_EVENT } from '../lib/vaultActions'
import { baseName, notePathOf, noteUrl } from '../lib/vault'
import { Symbol } from './Symbol'

/** A dragged tab, told apart from anything else dropped on the row. */
const DRAG_TYPE = 'application/x-nexlore-tab'

/** The tabs as they are now; showing `path` brings its tab to the front (or puts it into the one in front). */
function useNoteTabs(path: string): Tabs & { pinned: string[] } {
  const [tabs, setTabs] = useState(() => ({ ...readTabs(), pinned: readPinned() }))
  useEffect(() => {
    if (path) setTabs({ ...followTab(path), pinned: readPinned() })
  }, [path])
  useEffect(() => {
    const changed = () => setTabs({ ...readTabs(), pinned: readPinned() })
    window.addEventListener(TABS_EVENT, changed)
    return () => window.removeEventListener(TABS_EVENT, changed)
  }, [])
  // A note moved away or went into the trash: its tab goes (the page itself follows a note in front).
  useEffect(() => {
    const forgot = (event: Event) => forgetTabs((event as CustomEvent<string>).detail, path)
    window.addEventListener(FORGET_EVENT, forgot)
    return () => window.removeEventListener(FORGET_EVENT, forgot)
  }, [path])
  return tabs
}

export function TabBar({ path }: { path: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const tabs = useNoteTabs(path)
  const menu = useContextMenu()
  const [hover, setHover] = useState<string | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const close = (target: string) => {
    // The note in front is the one in the address now: a click on a tab changes it at once, the row is drawn again
    // only afterwards (on a slow machine a quick second click came in between and left the closed tab in front).
    const shown = notePathOf(window.location.pathname) ?? path
    const { front, next } = closeTab(target, shown)
    if (front) navigate(next ? noteUrl(next) : '/note')
  }
  const nameOf = (item: string) => baseName(item).replace(/\.md$/i, '')
  // One note open is no row of tabs: the space stays for the note (a phone has little of it).
  if (tabs.paths.length < 2) return null
  return (
    <div className="flex shrink-0 items-end border-b border-ink-700/80 bg-ink-950/40">
      <div role="tablist" aria-label={t('tabs.label')} data-testid="note-tabs" className="nn-scroll flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2 pt-1.5 [scrollbar-width:thin]">
        {tabs.paths.map((item, index) => {
          const front = index === tabs.active
          const pinned = tabs.pinned.includes(item)
          const name = nameOf(item)
          return (
            <div
              key={item}
              draggable
              data-tab={item}
              data-pinned={pinned || undefined}
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, item)
                event.dataTransfer.effectAllowed = 'move'
                setDragged(item)
              }}
              onDragEnd={() => setDragged(null)}
              onDragOver={(event) => {
                if (dragged && event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault()
              }}
              onDrop={(event) => {
                const moving = event.dataTransfer.getData(DRAG_TYPE)
                if (!moving) return
                event.preventDefault()
                // Onto the right half of a tab: after it.
                const box = event.currentTarget.getBoundingClientRect()
                const after = event.clientX > box.left + box.width / 2
                const from = tabs.paths.indexOf(moving)
                const target = index + (after ? 1 : 0)
                moveTab(moving, from < target ? target - 1 : target)
                setDragged(null)
              }}
              onMouseEnter={() => setHover(item)}
              onMouseLeave={() => setHover(null)}
              {...menuTriggers((x, y) =>
                menu.open(x, y, [
                  { label: t(pinned ? 'tabs.unpin' : 'tabs.pin'), symbol: 'pin', onSelect: () => pinTab(item, !pinned) },
                  'separator',
                  { label: t('tabs.closeOne'), symbol: 'close', onSelect: () => close(item) },
                  { label: t('tabs.closeOthers'), onSelect: () => {
                    closeOtherTabs(item)
                    if (!front) navigate(noteUrl(item))
                  } },
                ]),
              )}
              className={
                'group flex shrink-0 items-center rounded-t-lg border border-b-0 text-[13px] ' +
                (pinned ? 'max-w-40 ' : 'max-w-52 min-w-24 ') +
                (dragged === item ? 'opacity-50 ' : '') +
                (front ? 'border-ink-700 bg-ink-900 text-mist-100' : 'border-transparent text-mist-400 hover:bg-ink-850 hover:text-mist-200')
              }
            >
              <button
                type="button"
                role="tab"
                aria-selected={front}
                title={pinned ? `${item} · ${t('tabs.pinned')}` : item}
                onClick={() => !front && navigate(noteUrl(item))}
                onAuxClick={(event) => {
                  // The middle button closes, but not a pinned tab: that takes its menu.
                  if (event.button === 1 && !pinned) {
                    event.preventDefault()
                    close(item)
                  }
                }}
                className={'flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left ' + (pinned ? 'px-2.5' : 'pr-1 pl-3')}
              >
                {pinned && <Symbol name="pin" className="h-3 w-3 shrink-0 text-accent-400" />}
                <span className="truncate">{name}</span>
              </button>
              {!pinned && (
                <button
                  type="button"
                  aria-label={t('tabs.close', { name })}
                  onClick={() => close(item)}
                  className={'mr-1 rounded p-0.5 text-mist-500 hover:bg-ink-800 hover:text-mist-100 ' + (front || hover === item ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100')}
                >
                  <Symbol name="close" className="h-3 w-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label={t('tabs.all', { count: tabs.paths.length })}
        title={t('tabs.all', { count: tabs.paths.length })}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          menu.open(
            box.right - 8,
            box.bottom,
            tabs.paths.map((item, index) => ({
              label: nameOf(item),
              symbol: tabs.pinned.includes(item) ? ('pin' as const) : ('note' as const),
              hint: index === tabs.active ? '●' : undefined,
              onSelect: () => navigate(noteUrl(item)),
            })),
          )
        }}
        data-testid="tab-list"
        className="mx-1 mb-1 flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-mist-500 hover:bg-ink-850 hover:text-mist-100"
      >
        {tabs.paths.length}
        <Symbol name="chevronDown" className="h-3 w-3" />
      </button>
      {menu.element}
    </div>
  )
}
