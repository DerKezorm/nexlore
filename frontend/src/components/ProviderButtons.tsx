/**
 * The sign-in providers as buttons, in the order of the operator's list, with the line "or" above them: on the sign-in
 * page "Sign in with …", on the invitation page "Continue with …" (the invitation travels along to the provider).
 * Words from the shared sign-in module (`oidc.login.*`, `oidc.invite.button`), the same in every nex app.
 */
import { useTranslation } from 'react-i18next'

import type { ProviderButton } from '../api/client'

export function OrLine() {
  const { t } = useTranslation()
  return (
    <div className="my-4 flex items-center gap-3 text-xs text-mist-600">
      <span className="h-px flex-1 bg-ink-700" />
      {t('oidc.login.or')}
      <span className="h-px flex-1 bg-ink-700" />
    </div>
  )
}

/** Where a provider's button leads: its start, with the invitation when there is one. */
function startAddress(slug: string, invite?: string): string {
  const start = `/api/oidc/${encodeURIComponent(slug)}/start`
  return invite ? `${start}?invite=${encodeURIComponent(invite)}` : start
}

export function ProviderButtons({
  providers,
  invite,
  withOr = true,
}: {
  providers: ProviderButton[]
  /** The invitation's key: the buttons say "Continue with" and take it along. */
  invite?: string
  /** The line "or" above, when something stands before the buttons. */
  withOr?: boolean
}) {
  const { t } = useTranslation()
  if (providers.length === 0) return null
  return (
    <>
      {withOr && <OrLine />}
      <div className="space-y-2">
        {providers.map((provider) => (
          <button
            key={provider.slug}
            type="button"
            onClick={() => window.location.assign(startAddress(provider.slug, invite))}
            className="flex h-10 w-full items-center justify-center rounded-full border border-ink-700 text-sm font-medium hover:bg-ink-850"
          >
            {invite ? t('oidc.invite.button', { name: provider.label }) : t('oidc.login.button', { name: provider.label })}
          </button>
        ))}
      </div>
    </>
  )
}
