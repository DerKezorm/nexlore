/**
 * Following an invitation: with an account already (signed in), it only adds the right; without one, it makes one,
 * with a password or through the provider.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { ApiError, authApi, type InviteOffer, type Methods } from '../api/client'
import { AuthFrame, Field, PrimaryButton, Problem } from '../components/AuthFrame'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'
import { MIN_PASSWORD } from './SetupPage'

export function InvitePage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [offer, setOffer] = useState<InviteOffer | null>(null)
  const [methods, setMethods] = useState<Methods | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    authApi.offer(token).then(setOffer, () => setInvalid(true))
    void authApi.methods().then(setMethods, () => setMethods(null))
  }, [token])

  const done = async (space: string | null) => {
    await refresh()
    navigate(space ? `/?space=${encodeURIComponent(space)}` : '/', { replace: true })
  }

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true)
    setProblem(null)
    try {
      await done(await action())
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    } finally {
      setBusy(false)
    }
  }

  if (invalid) {
    return (
      <AuthFrame title={t('auth.invite.invalidTitle')} text={t('auth.invite.invalidText')}>
        <Link to="/login" className="text-sm text-accent-400 hover:underline">
          {t('auth.invite.toLogin')}
        </Link>
      </AuthFrame>
    )
  }
  if (!offer) return <AuthFrame title={t('common.loading')}>{null}</AuthFrame>

  const what = offer.space
    ? t('auth.invite.intoSpace', { space: offer.space, role: t(`roles.${offer.role ?? 'read'}`) })
    : t('auth.invite.intoNexlore')

  if (offer.signed_in_as) {
    return (
      <AuthFrame title={t('auth.invite.title')} text={what}>
        <div className="space-y-4">
          <Problem text={problem} />
          {offer.space ? (
            <PrimaryButton type="button" busy={busy} onClick={() => void run(async () => (await authApi.join(token)).space)}>
              {t('auth.invite.join', { name: offer.signed_in_as })}
            </PrimaryButton>
          ) : (
            <p className="text-sm text-mist-400">{t('auth.invite.haveAccount', { name: offer.signed_in_as })}</p>
          )}
        </div>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title={t('auth.invite.title')} text={what}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (password !== again) return setProblem(t('auth.mismatch'))
          void run(async () => {
            await authApi.accept(token, name.trim(), password)
            return offer.space
          })
        }}
      >
        <Problem text={problem} />
        {methods?.password !== false && (
          <>
            <Field label={t('auth.name')} value={name} onChange={setName} autoComplete="username" autoFocus hint={t('auth.nameHint')} />
            <Field
              label={t('auth.password')}
              value={password}
              onChange={setPassword}
              type="password"
              autoComplete="new-password"
              hint={t('auth.passwordHint', { count: offer.min_password || MIN_PASSWORD })}
            />
            <Field label={t('auth.passwordAgain')} value={again} onChange={setAgain} type="password" autoComplete="new-password" />
            <PrimaryButton busy={busy}>{t('auth.invite.create')}</PrimaryButton>
          </>
        )}
      </form>
      {methods?.oidc && (
        <a
          href={`/api/oidc/start?invite=${encodeURIComponent(token)}`}
          className="mt-4 flex h-10 w-full items-center justify-center rounded-full border border-ink-700 text-sm font-medium hover:bg-ink-850"
        >
          {t('auth.invite.oidc', { name: methods.oidc_name || 'OpenID Connect' })}
        </a>
      )}
      <p className="mt-4 text-xs text-mist-500">
        {t('auth.invite.already')}{' '}
        <Link to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className="text-accent-400 hover:underline">
          {t('auth.invite.signIn')}
        </Link>
      </p>
    </AuthFrame>
  )
}
