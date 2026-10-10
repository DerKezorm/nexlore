/**
 * "Works only once you set up a second factor." for a key, token or calendar address of an account that must set up
 * a second factor but has none yet, and is spared the duty in this session because it came in through a provider
 * that checks the second factor itself (rule of 10.10.2026). Keys have no session: they ask the account and stay
 * dead until it enrols. Making one stays possible; this only says so, with the way to the setup.
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { useAuth } from '../state/auth'

export function KeyFactorHint({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  if (!me?.keys_need_second_factor) return null
  return (
    <p
      role="note"
      data-testid="key-needs-factor"
      className={(compact ? 'mt-1 text-xs' : 'mb-3 rounded-lg border border-warn-500/30 bg-warn-500/10 px-3 py-2 text-sm') + ' text-warn-500'}
    >
      {t('keyFactor.text')}{' '}
      <Link to="/account?tab=security" className="underline">
        {t('keyFactor.link')}
      </Link>
    </p>
  )
}
