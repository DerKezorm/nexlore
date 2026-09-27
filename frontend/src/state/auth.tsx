/**
 * Who is signed in. Asked once at the start (is nexlore set up, is there a session) and again after signing in or
 * out. A request that finds the session gone (`sign_in_required`) sends the page back to the sign-in: see `api()`.
 *
 * The account's language wins over the browser's once somebody is signed in: it travels with the account from one
 * device to the next.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, authApi, SIGNED_OUT_EVENT, type Me } from '../api/client'
import { changeLanguage } from '../i18n'
import { clearCaches } from '../lib/offline'

type Status = 'loading' | 'setup' | 'signedOut' | 'signedIn' | 'error'

type Auth = {
  status: Status
  me: Me | null
  refresh: () => Promise<Me | null>
  signOut: () => Promise<void>
  /** The own language, remembered with the account; empty follows the browser. */
  setLanguage: (code: string) => Promise<void>
}

const AuthContext = createContext<Auth | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const [status, setStatus] = useState<Status>('loading')
  const [me, setMe] = useState<Me | null>(null)

  const refresh = useCallback(async () => {
    try {
      const setup = await authApi.setupState()
      if (setup.needs_setup || !setup.signed_in) {
        setMe(null)
        setStatus(setup.needs_setup ? 'setup' : 'signedOut')
        return null
      }
      const account = await authApi.me()
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
    void refresh()
    const gone = () => {
      setMe(null)
      setStatus('signedOut')
      void clearCaches()
    }
    window.addEventListener(SIGNED_OUT_EVENT, gone)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, gone)
  }, [refresh])

  const signOut = useCallback(async () => {
    try {
      await authApi.logout()
    } finally {
      await clearCaches()
      setMe(null)
      setStatus('signedOut')
    }
  }, [])

  const setLanguage = useCallback(async (code: string) => {
    await changeLanguage(code)
    const account = await authApi.setLanguage(code)
    setMe((current) => (current ? { ...current, language: account.language } : current))
  }, [])

  const value = useMemo<Auth>(() => ({ status, me, refresh, signOut, setLanguage }), [status, me, refresh, signOut, setLanguage])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth outside of AuthProvider')
  return auth
}
