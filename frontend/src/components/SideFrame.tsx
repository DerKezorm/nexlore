/**
 * The frame every sidebar shares, as in nexnotes: at the top "New note" and the search, at the bottom the own picture,
 * the name and a gear, the way to the settings. Between them each page puts its own: the spaces and tags, the
 * conversations of Ask Lore, what is due in the calendar, the views of the tasks, the areas of the settings.
 * `SideFrame` is the column for a page that has no sidebar of its own (the spaces' `Sidebar` brings the two ends
 * itself). Below 768 pixels there is no column: the header keeps "New note" and the search, its picture leads to the
 * settings.
 */
import { useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { askCapture } from '../lib/capture'
import { askNewNoteHere, useNewNoteTarget } from '../lib/newNote'
import { askSearch } from '../lib/shell'
import { useAuth } from '../state/auth'
import { Avatar } from './Avatar'
import { Symbol } from './Symbol'

/** "New note" and the search, at the top of a sidebar. A long press or a right click on "New note" captures quickly. */
export function SideTop({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const target = useNewNoteTarget()
  const press = useRef<{ timer: number; long: boolean }>({ timer: 0, long: false })
  const start = () => {
    window.clearTimeout(press.current.timer)
    press.current.long = false
    press.current.timer = window.setTimeout(() => {
      press.current.long = true
      askCapture()
    }, 500)
  }
  const end = () => window.clearTimeout(press.current.timer)
  const newNote = {
    onClick: () => {
      // The end of a long press is no click: quick capture is open already.
      if (press.current.long) return void (press.current.long = false)
      askNewNoteHere()
    },
    onPointerDown: start,
    onPointerUp: end,
    onPointerLeave: end,
    onPointerCancel: end,
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault()
      end()
      if (!press.current.long) askCapture()
    },
  }
  if (compact)
    return (
      <>
        <button type="button" {...newNote} disabled={!target} aria-label={t('sidebar.newNote')} title={target ? t('sidebar.newNoteShortcut') : t('today.none')} data-testid="side-new-note" className="rounded-lg bg-accent-500 p-2 text-on-accent hover:bg-accent-400 disabled:opacity-40">
          <Symbol name="plus" className="h-4 w-4" />
        </button>
        <button type="button" onClick={askSearch} aria-label={t('search.button')} title={`${t('search.button')} (${t('search.shortcut')})`} data-testid="side-search" className="rounded-lg p-2 text-mist-400 hover:bg-ink-850 hover:text-mist-100">
          <Symbol name="search" className="h-4 w-4" />
        </button>
      </>
    )
  return (
    <div className="shrink-0 space-y-2 p-2" data-testid="side-top">
      <button
        type="button"
        {...newNote}
        disabled={!target}
        aria-label={t('sidebar.newNote')}
        title={target ? t('sidebar.newNoteShortcut') : t('today.none')}
        data-testid="side-new-note"
        className="flex h-10 w-full items-center justify-center gap-2 rounded-[9px] bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40"
      >
        <Symbol name="plus" /> {t('sidebar.newNote')}
      </button>
      <button
        type="button"
        onClick={askSearch}
        aria-label={t('search.button')}
        title={`${t('search.button')} (${t('search.shortcut')})`}
        data-testid="side-search"
        className="flex h-10 w-full items-center gap-2 rounded-[9px] border border-ink-700 bg-ink-850 px-3 text-sm text-mist-500 hover:text-mist-100"
      >
        <Symbol name="search" />
        <span className="min-w-0 flex-1 truncate text-left">{t('search.button')}</span>
        <kbd className="rounded border border-ink-700 px-1.5 text-[11px]">{t('search.shortcut')}</kbd>
      </button>
    </div>
  )
}

/** The way to the settings in the corner: picture, name and gear; on a rail or in the header the picture alone. */
export function SettingsCorner({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  if (!me) return null
  const shown = me.display_name || me.name
  const label = `${shown} · ${t('nav.settings')}`
  if (compact)
    return (
      <NavLink
        to="/settings"
        aria-label={label}
        title={label}
        data-testid="settings-link"
        className={({ isActive }) => 'block h-8 w-8 shrink-0 rounded-full border ' + (isActive ? 'border-accent-500' : 'border-ink-700 hover:border-accent-500')}
      >
        <Avatar account={me} className="h-full w-full text-sm" />
      </NavLink>
    )
  return (
    <div className="shrink-0 border-t border-ink-700/80 p-2">
      <NavLink
        to="/settings"
        aria-label={label}
        title={label}
        data-testid="settings-link"
        className={({ isActive }) =>
          'flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-sm transition-colors ' +
          (isActive ? 'bg-accent-500/15 font-medium text-accent-400' : 'text-mist-300 hover:bg-ink-850 hover:text-mist-100')
        }
      >
        <Avatar account={me} className="h-7 w-7 shrink-0 text-xs" />
        {/* The gear says "settings"; the word stays for screen readers and the tooltip. */}
        <span className="min-w-0 flex-1 truncate">{shown}</span>
        <Symbol name="cog" className="h-4 w-4 shrink-0" />
      </NavLink>
    </div>
  )
}

/** The sidebar of a page without a sidebar of its own: the two ends, and the page's own part between them. */
export function SideFrame({ label, children, testId }: { label: string; children?: ReactNode; testId?: string }) {
  return (
    <aside aria-label={label} data-testid={testId ?? 'side-frame'} className="hidden w-64 shrink-0 flex-col border-r border-ink-700/80 bg-ink-950/60 md:flex">
      <SideTop />
      <div className="nn-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
      <SettingsCorner />
    </aside>
  )
}
