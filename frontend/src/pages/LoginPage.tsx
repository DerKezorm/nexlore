/** Signing in: name and password, or the provider's button when the operator set one up. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, authApi, type Methods } from '../api/client'
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
    setBusy(true)
    setProblem(null)
    try {
      await authApi.login(name.trim(), password)
      await refresh()
      navigate(next, { replace: true })
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
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
