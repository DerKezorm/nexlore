/**
 * Who else has the note open right now, in its header: their pictures side by side, the one writing first with a
 * pencil on the picture. This tab says every little while that it is here (`lib/presence.usePresence`), and goodbye when it goes.
 */
import { useTranslation } from 'react-i18next'

import type { Present } from '../api/client'
import { usePeople } from '../lib/people'
import { Avatar } from './Avatar'
import { Symbol } from './Symbol'

/** Pictures shown; the rest as a number. */
const SHOWN = 4

export function Presence({ people }: { people: Present[] }) {
  const { t } = useTranslation()
  const nameOf = usePeople()
  if (!people.length) return null
  const shown = people.slice(0, SHOWN)
  const names = people.map((person) => t(person.writing ? 'presence.writing' : 'presence.reading', { name: nameOf(person.name) })).join(', ')
  return (
    <div className="flex shrink-0 items-center -space-x-1.5" title={names} aria-label={names} role="group" data-testid="presence">
      {shown.map((person) => (
        <span key={person.id} className="relative" data-person={person.name} data-writing={person.writing || undefined}>
          <Avatar account={person} className={'h-6 w-6 text-[11px] ring-2 ' + (person.writing ? 'ring-accent-500' : 'ring-ink-950')} />
          {person.writing && (
            <span className="absolute -right-1 -bottom-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-accent-500 text-on-accent">
              <Symbol name="pencil" className="h-2.5 w-2.5" />
            </span>
          )}
        </span>
      ))}
      {people.length > SHOWN && <span className="grid h-6 min-w-6 place-items-center rounded-full bg-ink-850 px-1 text-[11px] text-mist-300 ring-2 ring-ink-950">+{people.length - SHOWN}</span>}
    </div>
  )
}
