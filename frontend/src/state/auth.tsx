/**
 * Who is signed in. Asked once at the start (is nexlore set up, is there a session) and again after signing in or
 * out. A request that finds the session gone (`sign_in_required`) sends the page back to the sign-in: see `api()`.
 *
 * The account's language wins over the browser's once somebody is signed in: it travels with the account from one
 * device to the next.
 */
import { applyAppearance, DEFAULT_APPEARANCE, type Appearance } from '../lib/appearance'
import { applyOwnCss, applyThemeColours } from '../lib/themes'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, authApi, setSignedOut, SIGNED_OUT_EVENT, type Me, themesApi } from '../api/client'
import { rememberName } from '../lib/people'
import { changeLanguage } from '../i18n'
import { forgetSharedKeys, setStorageOwner } from '../lib/accountStorage'
import { clearCaches } from '../lib/offline'

type Status = 'loading' | 'setup' | 'signedOut' | 'signedIn' | 'error'

type Auth = {
  status: Status
  me: Me | null
  refresh: () => Promise<Me | null>
  signOut: () => Promise<void>
  /** The own language, remembered with the account; empty follows the browser. */
  setLanguage: (code: string) => Promise<void>
  /** How nexlore looks for the account; only the values given change. */
  setAppearance: (changes: Partial<Appearance>) => Promise<void>
}

const AuthContext = createContext<Auth | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const [status, setStatus] = useState<Status>('loading')
  const [me, setMe] = useState<Me | null>(null)
  const appearanceWrites = useRef<Promise<unknown>>(Promise.resolve())
  const appearanceTicket = useRef(0)
  const themePending = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const setup = await authApi.setupState()
      if (setup.needs_setup || !setup.signed_in) {
        setStorageOwner(null)
        setMe(null)
        setStatus(setup.needs_setup ? 'setup' : 'signedOut')
        return null
      }
      const account = await authApi.me()
      applyAppearance(account.appearance ?? DEFAULT_APPEARANCE)
      applyThemeColours(account.theme_colours)
      applyOwnCss(account.own_css)
      setStorageOwner(account.id)
      rememberName(account.name, account.display_name)
      setSignedOut(false)
      setMe(account)
      setStatus('signedIn')
      if (account.language && account.language !== i18n.language) await changeLanguage(account.language)
      return account
    } catch (problem) {
      setMe(null)
      setStatus(problem instanceof ApiError && problem.status === 401 ? 'signedOut' : 'error')
      return null
    }
  }, [i18n])

  useEffect(() => {
    forgetSharedKeys()
    void refresh()
    const gone = () => {
      setStorageOwner(null)
      setMe(null)
      setStatus('signedOut')
      void clearCaches()
    }
    window.addEventListener(SIGNED_OUT_EVENT, gone)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, gone)
  }, [refresh])

  const signOut = useCallback(async () => {
    // Before the sign-out itself: what the page still asks meanwhile would come back as 401 (P1.23).
    setSignedOut(true)
    try {
      await authApi.logout()
    } finally {
      await clearCaches()
      setStorageOwner(null)
      setMe(null)
      setStatus('signedOut')
    }
  }, [])

  const setLanguage = useCallback(async (code: string) => {
    await changeLanguage(code)
    const account = await authApi.setLanguage(code)
    setMe((current) => (current ? { ...current, language: account.language } : current))
  }, [])

  const setAppearance = useCallback(async (changes: Partial<Appearance>) => {
    // Shown at once; the server's answer (with what it took) follows.
    setMe((current) => {
      if (!current) return current
      const next = { ...(current.appearance ?? DEFAULT_APPEARANCE), ...changes }
      applyAppearance(next)
      return { ...current, appearance: next }
    })
    // One after the other: sent side by side, the one that arrived last won, not the one meant last (Alt+B twice
    // left the sidebar folded). Only the answer to the latest change is shown; earlier ones would flicker back.
    const ticket = ++appearanceTicket.current
    if ('theme' in changes) themePending.current = true
    const sent = appearanceWrites.current.then(() => authApi.setAppearance(changes))
    appearanceWrites.current = sent.catch(() => undefined)
    const saved = await sent
    if (ticket !== appearanceTicket.current) return
    applyAppearance(saved)
    // Another theme: its colours, from the server (nexlore's own has none).
    const themeChanged = themePending.current
    themePending.current = false
    const colours = themeChanged ? (saved.theme === 'nexlore' ? null : (await themesApi.one(saved.theme)).colours) : undefined
    if (colours !== undefined) applyThemeColours(colours)
    setMe((current) => (current ? { ...current, appearance: saved, ...(colours !== undefined ? { theme_colours: colours } : {}) } : current))
  }, [])

  const value = useMemo<Auth>(() => ({ status, me, refresh, signOut, setLanguage, setAppearance }), [status, me, refresh, signOut, setLanguage, setAppearance])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth outside of AuthProvider')
  return auth
}
