/**
 * Signing in: name and password, or the provider's button when the operator set one up. An account with a second
 * factor gives the code from its app (or a recovery code) in a second step; too many wrong codes or too long a wait
 * start over with the password.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, authApi, totpApi, type Methods } from '../api/client'
import { AuthFrame, Field, PrimaryButton, Problem } from '../components/AuthFrame'
import { safeNext } from '../lib/auth'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'

export function LoginPage() {
  const { t } = useTranslation()
  const { status, refresh } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [methods, setMethods] = useState<Methods | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(params.get('error'))
  const next = safeNext(params.get('next'))

  useEffect(() => {
    void authApi.methods().then(setMethods, () => setMethods({ password: true, oidc: false, oidc_name: '' }))
  }, [])

  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedIn') return <Navigate to={next} replace />

  const submit = async () => {
    // Nothing to ask the server about: say which field is empty (P1.22).
    if (step !== 'code' && !name.trim()) return setProblem('name_missing')
    if (step !== 'code' && !password) return setProblem('password_missing')
    setBusy(true)
    setProblem(null)
    try {
      if (step === 'code') {
        await totpApi.code(code.trim())
      } else {
        const answer = await authApi.login(name.trim(), password)
        if ('second_factor' in answer) {
          setPassword('')
          setStep('code')
          return
        }
      }
      await refresh()
      navigate(next, { replace: true })
    } catch (error) {
      const found = error instanceof ApiError ? error.code : 'internal_error'
      setProblem(found)
      // Too many wrong codes, or too long a wait: the password once more.
      if (found === 'second_factor_expired') {
        setStep('password')
        setCode('')
      }
    } finally {
      setBusy(false)
    }
  }

  if (step === 'code') {
    return (
      <AuthFrame title={t('twofactor.loginTitle')} text={t('twofactor.loginText')}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) void submit()
          }}
        >
          <Problem text={problem ? errorText(problem) : null} />
          <Field label={t('twofactor.code')} value={code} onChange={setCode} autoComplete="one-time-code" autoFocus hint={t('twofactor.codeHint')} />
          <PrimaryButton busy={busy}>{t('auth.login.submit')}</PrimaryButton>
          <button
            type="button"
            className="w-full text-center text-xs text-mist-500 hover:text-mist-300"
            onClick={() => {
              void totpApi.cancel().catch(() => undefined)
              setStep('password')
              setCode('')
              setProblem(null)
            }}
          >
            {t('twofactor.back')}
          </button>
        </form>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title={t('auth.login.title')} text={t('auth.login.text')}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Problem text={problem ? errorText(problem) : null} />
        <Field label={t('auth.name')} value={name} onChange={setName} autoComplete="username" autoFocus />
        <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" />
        <PrimaryButton busy={busy}>{t('auth.login.submit')}</PrimaryButton>
        {methods && !methods.password && <p className="text-xs text-mist-500">{t('auth.login.passwordOff')}</p>}
      </form>
      {methods?.oidc && (
        <>
          <div className="my-4 flex items-center gap-3 text-xs text-mist-600">
            <span className="h-px flex-1 bg-ink-700" />
            {t('auth.or')}
            <span className="h-px flex-1 bg-ink-700" />
          </div>
          <a
            href="/api/oidc/start"
            className="flex h-10 w-full items-center justify-center rounded-full border border-ink-700 text-sm font-medium hover:bg-ink-850"
          >
            {t('auth.login.oidc', { name: methods.oidc_name || 'OpenID Connect' })}
          </a>
        </>
      )}
    </AuthFrame>
  )
}
