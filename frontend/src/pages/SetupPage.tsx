/** The very first start: the account made here is the operator's. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate } from 'react-router-dom'

import { ApiError, authApi } from '../api/client'
import { AuthFrame, Field, PrimaryButton, Problem } from '../components/AuthFrame'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'

export const MIN_PASSWORD = 12

export function SetupPage() {
  const { t, i18n } = useTranslation()
  const { status, refresh } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  if (status === 'loading') return null
  if (status === 'signedIn') return <Navigate to="/" replace />
  if (status === 'signedOut') return <Navigate to="/login" replace />

  const submit = async () => {
    if (!name.trim()) return setProblem(errorText('name_missing'))
    if (!password) return setProblem(errorText('password_missing'))
    if (password !== again) return setProblem(t('auth.mismatch'))
    setBusy(true)
    setProblem(null)
    try {
      await authApi.setup(name.trim(), password, i18n.language)
      await refresh()
      navigate('/', { replace: true })
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame title={t('auth.setup.title')} text={t('auth.setup.text')}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Problem text={problem} />
        <Field label={t('auth.name')} value={name} onChange={(value) => setName(value.toLowerCase())} autoComplete="username" autoFocus hint={t('auth.nameHint')} />
        <Field
          label={t('auth.password')}
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="new-password"
          hint={t('auth.passwordHint', { count: MIN_PASSWORD })}
        />
        <Field label={t('auth.passwordAgain')} value={again} onChange={setAgain} type="password" autoComplete="new-password" />
        <PrimaryButton busy={busy}>{t('auth.setup.submit')}</PrimaryButton>
      </form>
    </AuthFrame>
  )
}
