/** A person's picture, or the first letter of the name when there is none (or it cannot be loaded). */
import { useState } from 'react'

function avatarUrl(account: { id: number; avatar: string | null }): string | null {
  return account.avatar ? `/api/avatars/${account.id}?v=${encodeURIComponent(account.avatar)}` : null
}

export function Avatar({ account, className = '' }: { account: { id: number; name: string; avatar: string | null }; className?: string }) {
  const url = avatarUrl(account)
  const [failed, setFailed] = useState<string | null>(null)
  if (url && failed !== url)
    return <img src={url} alt="" onError={() => setFailed(url)} className={'rounded-full object-cover ' + className} data-testid="avatar" />
  return (
    <span className={'grid place-items-center rounded-full bg-accent-500/15 font-semibold text-accent-400 ' + className} data-testid="avatar-letter">
      {account.name.slice(0, 1).toUpperCase()}
    </span>
  )
}
