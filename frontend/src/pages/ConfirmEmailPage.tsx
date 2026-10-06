/**
 * The page behind the link in the confirmation mail (issue #13). It works without being signed in: the link is the
 * proof. It confirms once, when it opens; used again, too late or replaced by a newer link it says so.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'

import { ApiError, authApi } from '../api/client'
import { AuthFrame, Problem } from '../components/AuthFrame'
import { errorText } from '../lib/errors'

type State = { kind: 'busy' } | { kind: 'done'; email: string; name: string } | { kind: 'failed'; code: string }

export function ConfirmEmailPage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const [state, setState] = useState<State>({ kind: 'busy' })
  // React may mount the page twice while developing; the link works once, so it is sent once.
  const asked = useRef(false)

  useEffect(() => {
    if (asked.current) return
    asked.current = true
    authApi.confirmEmail(token).then(
      (answer) => setState({ kind: 'done', ...answer }),
      (error) => setState({ kind: 'failed', code: error instanceof ApiError ? error.code : 'internal_error' }),
    )
  }, [token])

  if (state.kind === 'busy') return <AuthFrame title={t('confirmEmail.busy')}>{null}</AuthFrame>
  return (
    <AuthFrame
      title={state.kind === 'done' ? t('confirmEmail.title') : t('confirmEmail.failed')}
      text={state.kind === 'done' ? t('confirmEmail.text', { email: state.email, name: state.name }) : undefined}
    >
      {state.kind === 'failed' && <Problem text={errorText(state.code)} />}
      <Link
        to="/account"
        className="mt-4 inline-flex h-10 items-center rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-400"
      >
        {t('confirmEmail.toApp')}
      </Link>
    </AuthFrame>
  )
}
