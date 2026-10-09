/**
 * Signing in: name and password, and below the line "or" a button per active sign-in provider, in the order of the
 * operator's list. With the password sign-in turned off only the buttons show, and small at the bottom the operator's
 * way in with the password. An account with a second factor gives the code from its app (or a recovery code) in a
 * second step; too many wrong codes or too long a wait start over. The second step comes after a provider, too, when
 * that provider is not trusted with the second factor (`?step=code`, the server parked the sign-in).
 *
 * An error from the address (`?error=`) is shown only as one of the fixed sign-in codes, never as it stands there.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, authApi, totpApi, type Methods } from '../api/client'
import { AuthFrame, Field, PrimaryButton, Problem } from '../components/AuthFrame'
import { ProviderButtons } from '../components/ProviderButtons'
import { safeNext } from '../lib/auth'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'
import { oidcErrorKey } from '../vendor/nexoidc/oidc'

export function LoginPage() {
  const { t } = useTranslation()
  const { status, refresh } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [methods, setMethods] = useState<Methods | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep] = useState<'password' | 'code'>(params.get('step') === 'code' ? 'code' : 'password')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // What the provider's way back said: only a known code becomes a sentence.
  const [fromAddress, setFromAddress] = useState<string | null>(oidcErrorKey(params.get('error')))
  // Password sign-in off: the form waits behind "Sign in as the operator with a password".
  const [operatorWay, setOperatorWay] = useState(false)
  const next = safeNext(params.get('next'))

  useEffect(() => {
    void authApi.methods().then(setMethods, () => setMethods({ password: true, providers: [] }))
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
    setFromAddress(null)
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
          <Problem text={problem ? errorText(problem) : fromAddress ? t(fromAddress) : null} />
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

  const providers = methods?.providers ?? []
  const passwordShown = !methods || methods.password || providers.length === 0 || operatorWay
  return (
    <AuthFrame title={t('auth.login.title')} text={t('auth.login.text')}>
      {passwordShown ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Problem text={problem ? errorText(problem) : fromAddress ? t(fromAddress) : null} />
          <Field label={t('auth.name')} value={name} onChange={setName} autoComplete="username" autoFocus />
          <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" />
          <PrimaryButton busy={busy}>{t('auth.login.submit')}</PrimaryButton>
        </form>
      ) : (
        <Problem text={fromAddress ? t(fromAddress) : null} />
      )}
      <ProviderButtons providers={providers} withOr={passwordShown} />
      {!passwordShown && (
        <button
          type="button"
          className="mt-4 w-full text-center text-xs text-mist-500 hover:text-mist-300"
          onClick={() => setOperatorWay(true)}
        >
          {t('oidc.login.operator')}
        </button>
      )}
    </AuthFrame>
  )
}
