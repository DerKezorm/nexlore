/** The circle at the top right: who is signed in, open AI drafts (M7), the language, the own account, signing out. */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'

import { draftsApi, type DraftInfo } from '../api/client'
import { languageOptions, type LanguageOption } from '../i18n'
import { askPalette } from '../lib/commands'
import { noteUrl } from '../lib/vault'
import { useAuth } from '../state/auth'
import { useInstall } from '../lib/install'
import { Avatar } from './Avatar'
import { DraftCompare } from './DraftCompare'
import { Symbol } from './Symbol'
import { ThemeSwitcher } from './ThemeSwitcher'

export function AccountMenu() {
  const { t, i18n } = useTranslation()
  const { me, signOut, setLanguage } = useAuth()
  const install = useInstall()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<LanguageOption[]>([])
  const box = useRef<HTMLDivElement>(null)
  const [drafts, setDrafts] = useState<DraftInfo[]>([])
  const [draftShown, setDraftShown] = useState<number | null>(null)

  // Open drafts, for the number on the circle: asked now, when the menu opens, and every minute.
  const signedIn = !!me
  useEffect(() => {
    if (!signedIn) return
    let live = true
    const ask = () => draftsApi.list().then((found) => live && setDrafts(found), () => undefined)
    void ask()
    const timer = window.setInterval(ask, 60_000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [signedIn, open])

  useEffect(() => {
    if (!open) return
    void languageOptions().then(setOptions)
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  if (!me) return null

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t('account.menu', { name: me.name })}
        className="relative flex h-8 w-8 items-center justify-center rounded-full border border-ink-700 hover:border-accent-500"
      >
        <Avatar account={me} className="h-full w-full text-sm" />
        {drafts.length > 0 && (
          <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent-500 px-1 text-[10px] font-bold text-on-accent" data-testid="drafts-count">
            {drafts.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-64 rounded-2xl border border-ink-700 bg-ink-900 p-2 text-sm shadow-2xl">
          {/* On a phone the switch has no room in the header: it lives here. */}
          <div className="flex justify-end px-3 py-2 sm:hidden">
            <ThemeSwitcher />
          </div>
          <div className="px-3 py-2">
            <div className="font-semibold text-mist-100">{me.name}</div>
            <div className="text-xs text-mist-500">{t(`account.role.${me.role}`)}</div>
          </div>
          {drafts.length > 0 && (
            <div className="border-y border-ink-800 py-1">
              <div className="px-3 pt-1 pb-0.5 text-xs text-mist-500">{t('drafts.open')}</div>
              {drafts.slice(0, 8).map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    if (draft.new) setDraftShown(draft.id)
                    else navigate(noteUrl(draft.path))
                  }}
                  className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-ink-850"
                >
                  <Symbol name="sparkle" className="mt-0.5 h-4 w-4 shrink-0 text-accent-400" />
                  <span className="min-w-0">
                    <span className="block truncate text-mist-100">{draft.new ? t('drafts.newNote', { title: draft.title }) : draft.title}</span>
                    <span className="block truncate text-xs text-mist-500">{draft.key_name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center justify-between gap-2 rounded-lg px-3 py-2">
            <span className="flex items-center gap-2 text-mist-400">
              <Symbol name="globe" /> {t('account.language')}
            </span>
            <select
              value={i18n.language}
              onChange={(event) => void setLanguage(event.target.value)}
              className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-xs"
            >
              {options.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <Link
            to="/account"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-mist-300 hover:bg-ink-850 hover:text-mist-100"
          >
            <Symbol name="users" /> {t('account.page')}
          </Link>
          <button type="button" onClick={() => { setOpen(false); askPalette() }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-mist-300 hover:bg-ink-850 hover:text-mist-100">
            <Symbol name="command" /> {t('palette.menu')}
            <kbd className="ml-auto hidden rounded border border-ink-700 px-1.5 text-[11px] text-mist-500 sm:inline">Ctrl P</kbd>
          </button>
          {/* On a phone the header keeps the four daily places; these two live here. */}
          <Link to="/files" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-mist-300 hover:bg-ink-850 hover:text-mist-100 sm:hidden">
            <Symbol name="files" /> {t('nav.files')}
          </Link>
          <Link to="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-mist-300 hover:bg-ink-850 hover:text-mist-100 sm:hidden">
            <Symbol name="settings" /> {t('nav.settings')}
          </Link>
          {install.can === 'prompt' && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                void install.install()
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-mist-300 hover:bg-ink-850 hover:text-mist-100"
            >
              <Symbol name="phone" /> {t('install.menu')}
            </button>
          )}
          {install.can === 'ios' && (
            <p className="flex gap-2 px-3 py-2 text-xs text-mist-500">
              <Symbol name="phone" className="h-4 w-4 shrink-0" /> {t('install.ios')}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void signOut().then(() => navigate('/login', { replace: true }))
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-mist-300 hover:bg-ink-850 hover:text-mist-100"
          >
            <Symbol name="open" /> {t('account.signOut')}
          </button>
        </div>
      )}
      {draftShown !== null && (
        <DraftCompare
          draftId={draftShown}
          onClose={() => setDraftShown(null)}
          onDone={(result) => {
            setDraftShown(null)
            void draftsApi.list().then(setDrafts, () => undefined)
            if (result.path) navigate(noteUrl(result.path))
          }}
        />
      )}
    </div>
  )
}
