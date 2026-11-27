/**
 * A person's picture, or, when there is none (or it cannot be loaded), the first letter of the name shown on the hue
 * of that name: the shared account module's stand-in (`avatarPlaceholder`), the same on the server, in the iPhone app
 * and in the operator's list of accounts; saturation, lightness and the letter's colour are nexlore's (`--nexui-avatar-*`).
 */
import { useState } from 'react'

import { avatarPlaceholder } from '../vendor/nexkonten/konten'

function avatarUrl(account: { id: number; avatar: string | null }): string | null {
  return account.avatar ? `/api/avatars/${account.id}?v=${encodeURIComponent(account.avatar)}` : null
}

export function Avatar({
  account,
  className = '',
}: {
  account: { id: number; name: string; display_name?: string; avatar: string | null }
  className?: string
}) {
  const url = avatarUrl(account)
  const [failed, setFailed] = useState<string | null>(null)
  if (url && failed !== url)
    return <img src={url} alt="" onError={() => setFailed(url)} className={'rounded-full object-cover ' + className} data-testid="avatar" />
  const stand = avatarPlaceholder(account.display_name || account.name)
  return (
    <span
      className={'grid place-items-center rounded-full font-semibold ' + className}
      style={{
        background: `hsl(${stand.hue} var(--nexui-avatar-saturation) var(--nexui-avatar-lightness))`,
        color: 'var(--nexui-avatar-text)',
      }}
      data-testid="avatar-letter"
    >
      {stand.letter}
    </span>
  )
}
