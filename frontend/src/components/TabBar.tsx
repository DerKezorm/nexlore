/**
 * The row of open notes above the note (`lib/tabs.ts`), from two notes on. A click shows a tab, the cross or the middle
 * button closes it. On a narrow screen the row scrolls sideways.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { closeTab, followTab, forgetTabs, readTabs, TABS_EVENT, type Tabs } from '../lib/tabs'
import { FORGET_EVENT } from '../lib/vaultActions'
import { baseName, noteUrl } from '../lib/vault'
import { Symbol } from './Symbol'

/** The tabs as they are now; showing `path` brings its tab to the front (or puts it into the one in front). */
function useNoteTabs(path: string): Tabs {
  const [tabs, setTabs] = useState<Tabs>(readTabs)
  useEffect(() => {
    if (path) setTabs(followTab(path))
  }, [path])
  useEffect(() => {
    const changed = () => setTabs(readTabs())
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
  const [hover, setHover] = useState<string | null>(null)
  const close = (target: string) => {
    const { front, next } = closeTab(target, path)
    if (front) navigate(next ? noteUrl(next) : '/note')
  }
  // One note open is no row of tabs: the space stays for the note (a phone has little of it).
  if (tabs.paths.length < 2) return null
  return (
    <div role="tablist" aria-label={t('tabs.label')} data-testid="note-tabs" className="nn-scroll flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-ink-700/80 bg-ink-950/40 px-2 pt-1.5 [scrollbar-width:thin]">
      {tabs.paths.map((item, index) => {
        const front = index === tabs.active
        const name = baseName(item).replace(/\.md$/i, '')
        return (
          <div
            key={item}
            onMouseEnter={() => setHover(item)}
            onMouseLeave={() => setHover(null)}
            className={
              'group flex max-w-52 min-w-24 shrink-0 items-center rounded-t-lg border border-b-0 text-[13px] ' +
              (front ? 'border-ink-700 bg-ink-900 text-mist-100' : 'border-transparent text-mist-400 hover:bg-ink-850 hover:text-mist-200')
            }
          >
            <button
              type="button"
              role="tab"
              aria-selected={front}
              title={item}
              onClick={() => !front && navigate(noteUrl(item))}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  close(item)
                }
              }}
              className="min-w-0 flex-1 truncate py-1.5 pr-1 pl-3 text-left"
            >
              {name}
            </button>
            <button
              type="button"
              aria-label={t('tabs.close', { name })}
              onClick={() => close(item)}
              className={'mr-1 rounded p-0.5 text-mist-500 hover:bg-ink-800 hover:text-mist-100 ' + (front || hover === item ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100')}
            >
              <Symbol name="close" className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
