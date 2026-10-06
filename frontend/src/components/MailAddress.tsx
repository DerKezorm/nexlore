/**
 * The own mail address in the profile (issue #13). Entered here it counts only once the link mailed to it is opened
 * (the address bridges a first sign-in through the provider, so nobody may claim somebody else's). An account that
 * signs in through the provider only shows the provider's address, read only. Without a mail server or a public
 * address no confirmation can go out: the field is locked and says why (the operator can still set one).
 */
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { authApi, type Me } from '../api/client'
import { Symbol } from './Symbol'

type Run = (action: () => Promise<unknown>, success: string) => Promise<void>

function Chip({ tone, children }: { tone: 'ok' | 'wait' | 'plain'; children: string }) {
  const colour =
    tone === 'ok' ? 'bg-ok-500/10 text-ok-500' : tone === 'wait' ? 'bg-warn-500/10 text-warn-500' : 'border border-ink-700 text-mist-300'
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ${colour}`}>{children}</span>
}

export function MailAddress({ me, run, busy, provider }: { me: Me; run: Run; busy: boolean; provider: string }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(me.email_pending || me.email)
  const fieldId = useId()
  const hintId = useId()
  const providerName = provider || t('account.profile.providerFallback')
  // A confirmation, a removal or the provider's address changes what counts: the field follows.
  useEffect(() => setDraft(me.email_pending || me.email), [me.email, me.email_pending])

  const source = me.email && me.email_source ? t(`account.profile.emailSource.${me.email_source}`, { provider: providerName }) : ''
  const label = (
    <label htmlFor={fieldId} className="mb-1 block text-sm font-medium">
      {t('account.profile.emailTitle')}
    </label>
  )

  if (me.sign_in === 'oidc') {
    return (
      <div data-testid="mail-address" className="text-sm">
        {label}
        <input
          id={fieldId}
          value={me.email}
          readOnly
          aria-describedby={hintId}
          className="h-10 w-full rounded-lg border border-ink-700 bg-ink-850/60 px-3 text-sm text-mist-300 outline-none"
        />
        <p id={hintId} className="mt-1 text-xs text-mist-500">
          {t('account.profile.emailProviderOnly', { provider: providerName })}
        </p>
      </div>
    )
  }

  const locked = me.email_confirm ?? ''
  const operator = me.role === 'operator'
  return (
    <div data-testid="mail-address" className="space-y-3 text-sm">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const address = draft.trim()
          // The address that counts already sends nothing (and only forgets one waiting): the server says so too.
          const same = address.toLowerCase() === me.email.toLowerCase()
          void run(
            () => authApi.setEmail(address),
            same ? t('account.profile.emailSame') : t('account.profile.emailSent', { address }),
          )
        }}
      >
        {label}
        {/* Field and buttons share a line that breaks on a phone; hint and status below take the whole width. */}
        <div className="flex flex-wrap gap-2">
          <input
            id={fieldId}
            type="email"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={Boolean(locked)}
            autoComplete="email"
            placeholder="name@example.com"
            aria-describedby={hintId}
            className="h-10 min-w-56 flex-1 rounded-lg border border-ink-700 bg-ink-850 px-3 text-sm outline-none focus:border-accent-500 disabled:text-mist-500 disabled:opacity-70"
          />
          {!locked && (
            <button
              type="submit"
              disabled={busy || !draft.trim() || draft.trim().toLowerCase() === (me.email_pending || me.email).toLowerCase()}
              className="h-10 rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40"
            >
              {t('account.profile.emailConfirm')}
            </button>
          )}
          {me.email && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => authApi.removeEmail(), t('account.profile.emailRemoved'))}
              className="h-10 rounded-full border border-ink-700 px-4 text-sm hover:bg-ink-850 disabled:opacity-50"
            >
              {t('account.profile.emailRemove')}
            </button>
          )}
        </div>
        <p id={hintId} className="mt-1 text-xs text-mist-500">
          {locked ? t(locked === 'mail_off' ? 'account.profile.emailNoServer' : 'account.profile.emailNoPublicUrl') : t('account.profile.emailHint')}
          {locked && operator && (
            <>
              {' '}
              <Link
                to={locked === 'mail_off' ? '/settings?tab=server&sub=mail' : '/settings?tab=server&sub=signin'}
                className="text-accent-400 underline underline-offset-2"
              >
                {t(locked === 'mail_off' ? 'account.profile.emailSetServer' : 'account.profile.emailSetPublicUrl')}
              </Link>
            </>
          )}
        </p>
        {me.email && (
          <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="mail-status">
            <Chip tone="ok">{`${t('account.profile.emailConfirmed')}: ${me.email}`}</Chip>
            {source && <Chip tone="plain">{source}</Chip>}
          </div>
        )}
      </form>

      {me.email_pending && (
        <div data-testid="mail-waiting" className="flex gap-2.5 rounded-xl border border-warn-500/35 bg-warn-500/10 px-3.5 py-3">
          <Symbol name="clock" className="mt-0.5 h-4 w-4 shrink-0 text-warn-500" />
          <div>
            <p>
              <strong>{t('account.profile.emailWaitTitle')}</strong> {t('account.profile.emailWait', { address: me.email_pending })}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || Boolean(locked)}
                onClick={() => void run(() => authApi.resendEmail(), t('account.profile.emailResent'))}
                className="rounded-full border border-ink-700 px-3 py-1 text-xs hover:bg-ink-850 disabled:opacity-50"
              >
                {t('account.profile.emailResend')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => authApi.cancelEmail(), t('account.profile.emailCancelled'))}
                className="rounded-full border border-ink-700 px-3 py-1 text-xs hover:bg-ink-850 disabled:opacity-50"
              >
                {t('account.profile.emailCancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {me.provider_email && (
        <div data-testid="mail-offer" className="flex gap-2.5 rounded-xl border border-accent-500/35 bg-accent-500/10 px-3.5 py-3">
          <Symbol name="info" className="mt-0.5 h-4 w-4 shrink-0 text-accent-400" />
          <div>
            <p>{t('account.profile.emailOffer', { provider: providerName, address: me.provider_email })}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => authApi.takeProviderEmail(), t('account.profile.emailTaken'))}
                className="rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50"
              >
                {t('account.profile.emailTake')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => authApi.declineProviderEmail(), t('account.profile.emailDeclined'))}
                className="rounded-full border border-ink-700 px-3 py-1 text-xs hover:bg-ink-850 disabled:opacity-50"
              >
                {t('account.profile.emailDecline')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
