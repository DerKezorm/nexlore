/** The circle at the top right: who is signed in, the language, the own account, signing out. */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'

import { languageOptions, type LanguageOption } from '../i18n'
import { useAuth } from '../state/auth'
import { Symbol } from './Symbol'

export function AccountMenu() {
  const { t, i18n } = useTranslation()
  const { me, signOut, setLanguage } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<LanguageOption[]>([])
  const box = useRef<HTMLDivElement>(null)

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
  const initial = me.name.slice(0, 1).toUpperCase()

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t('account.menu', { name: me.name })}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-ink-700 bg-accent-500/15 text-sm font-semibold text-accent-400 hover:border-accent-500"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-64 rounded-2xl border border-ink-700 bg-ink-900 p-2 text-sm shadow-2xl">
          <div className="px-3 py-2">
            <div className="font-semibold text-mist-100">{me.name}</div>
            <div className="text-xs text-mist-500">{t(`account.role.${me.role}`)}</div>
          </div>
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
    </div>
  )
}
