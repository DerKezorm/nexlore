/**
 * A person, as others see them: the display name, with the account name in the tooltip. `login` shows the account name
 * beside it as well, small (member lists, @names: that is what one signs in with and writes after @).
 */
import { useShownName } from '../lib/people'

export function Person({ name, login = false, className }: { name: string; login?: boolean; className?: string }) {
  const shown = useShownName(name)
  return (
    <span className={className} title={shown !== name ? `@${name}` : undefined} data-person={name}>
      {shown}
      {login && shown !== name && <span className="ml-1 text-xs font-normal text-mist-500">@{name}</span>}
    </span>
  )
}
