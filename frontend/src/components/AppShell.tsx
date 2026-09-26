import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'

import { errorText } from '../lib/errors'
import { noteUrl } from '../lib/vault'
import { useStore } from '../state/store'
import { Logo } from './Logo'
import { SearchDialog } from './SearchDialog'
import { Symbol, type SymbolName } from './Symbol'
import { ThemeSwitcher } from './ThemeSwitcher'

type NavItem = { to: string; label: 'nav.graph' | 'nav.notes' | 'nav.files' | 'nav.settings'; symbol: SymbolName; end: boolean; right?: boolean }

const ITEMS: NavItem[] = [
  { to: '/', label: 'nav.graph', symbol: 'graph', end: true },
  { to: '/note', label: 'nav.notes', symbol: 'note', end: false },
  { to: '/files', label: 'nav.files', symbol: 'files', end: false },
  { to: '/settings', label: 'nav.settings', symbol: 'settings', end: false, right: true },
]

function navClass(isActive: boolean, right = false): string {
  return (
    (right ? 'ml-auto ' : '') +
    'inline-flex shrink-0 items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ' +
    (isActive ? 'bg-accent-500/15 text-accent-400' : 'text-mist-500 hover:bg-ink-850 hover:text-mist-100')
  )
}

/** Shell like the other nex apps: header with pills, then the page fills the rest of the window. */
export function AppShell() {
  const { t } = useTranslation()
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearching(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const { status, error } = useStore()

  const pick = (id: string) => {
    if (location.pathname === '/') navigate(`/?focus=${encodeURIComponent(id)}`)
    else navigate(noteUrl(id))
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="z-20 shrink-0 border-b border-ink-700/80 bg-ink-950/80 backdrop-blur-xl">
        <div className="flex items-center gap-4 px-4 py-2.5">
          <NavLink to="/" className="shrink-0" aria-label={t('app.home')}>
            <Logo withWordmark />
          </NavLink>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label={t('app.mainMenu')}>
            {ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => navClass(isActive, item.right)}>
                <Symbol name={item.symbol} />
                <span className="hidden lg:inline">{t(item.label)}</span>
              </NavLink>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => setSearching(true)}
            className="hidden items-center gap-2 rounded-full border border-ink-700 bg-ink-850 py-1.5 pr-2 pl-3 text-sm text-mist-500 hover:text-mist-100 sm:inline-flex"
          >
            <Symbol name="search" />
            <span className="w-32 text-left">{t('search.button')}</span>
            <kbd className="rounded border border-ink-700 px-1.5 text-[11px]">{t('search.shortcut')}</kbd>
          </button>
          <ThemeSwitcher />
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-850 text-mist-400" title={t('app.account')}>
            <Symbol name="users" className="h-4 w-4" />
          </span>
        </div>
      </header>
      {status === 'error' && (
        <div className="shrink-0 border-b border-bad-500/30 bg-bad-500/10 px-4 py-2 text-sm text-bad-500" role="alert">
          {error === 'sign_in_required' ? t('app.closed') : errorText(error ?? 'internal_error')}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Outlet />
      </div>
      {searching && <SearchDialog onClose={() => setSearching(false)} onPick={pick} />}
    </div>
  )
}
