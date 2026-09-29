/**
 * Mentions without a link, under the backlinks: where other notes name this one (its name or an alias) as plain
 * words. Looked for only when opened (each note named is read on the server), and remembered open in this browser.
 * "Link" turns that place into a wiki link; the sentence reads the same.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, mentionsApi, type Mention } from '../api/client'
import { Symbol } from './Symbol'

const OPEN_KEY = 'nexlore.unlinked'

function remembered(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

type Props = {
  path: string
  onOpen: (path: string) => void
  /** A place became a link: the backlinks are asked again. */
  onLinked: () => void
  /** Open from the start, without the fold (the cleaning up page opens it on request). */
  alwaysOpen?: boolean
}

export function Unlinked({ path, onOpen, onLinked, alwaysOpen = false }: Props) {
  const { t } = useTranslation()
  const [folded, setOpen] = useState(remembered)
  const open = alwaysOpen || folded
  const [found, setFound] = useState<{ path: string; places: Mention[]; more: boolean } | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [refused, setRefused] = useState<Record<string, string>>({})
  const [ask, setAsk] = useState(0)

  useEffect(() => {
    if (!open) return
    let alive = true
    setFailed(false)
    mentionsApi.of(path).then(
      (answer) => alive && setFound({ path, ...answer }),
      () => alive && setFailed(true),
    )
    return () => {
      alive = false
    }
  }, [open, path, ask])

  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    } catch {
      /* private window: open for this visit only */
    }
  }

  const key = (place: Mention) => `${place.path}:${place.line}:${place.column}`
  const link = async (place: Mention) => {
    setBusy(key(place))
    try {
      await mentionsApi.link(path, place)
      setFound((was) => was && { ...was, places: was.places.filter((item) => key(item) !== key(place)) })
      onLinked()
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'internal_error'
      if (code === 'mention_moved') setAsk((n) => n + 1)
      else setRefused((was) => ({ ...was, [key(place)]: code === 'note_locked' ? t('unlinked.locked') : t('unlinked.failed') }))
    } finally {
      setBusy(null)
    }
  }

  const places = found?.path === path ? found.places : null
  const groups: { path: string; title: string; places: Mention[] }[] = []
  for (const place of places ?? []) {
    const last = groups[groups.length - 1]
    if (last?.path === place.path) last.places.push(place)
    else groups.push({ path: place.path, title: place.title, places: [place] })
  }

  return (
    <section className="mb-6" data-testid="unlinked">
      <h3 className="mb-2 px-2">
        <button
          type="button"
          onClick={toggle}
          disabled={alwaysOpen}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-[11px] font-semibold tracking-wider text-mist-500 uppercase hover:text-mist-300"
        >
          <Symbol name={open ? 'chevronDown' : 'chevronRight'} className="h-3.5 w-3.5" />
          {t('unlinked.title')}
          {places && <span className="ml-auto text-mist-600 tabular-nums">{places.length}{found?.more ? '+' : ''}</span>}
        </button>
      </h3>
      {open && (
        <>
          {failed && <p className="px-2 text-sm text-bad-500">{t('unlinked.loadFailed')}</p>}
          {!failed && !places && <p className="px-2 text-sm text-mist-600">{t('common.loading')}</p>}
          {places?.length === 0 && <p className="px-2 text-sm text-mist-600">{t('unlinked.none')}</p>}
          {groups.map((group) => (
            <div key={group.path} className="mb-2">
              <button type="button" onClick={() => onOpen(group.path)} className="block w-full truncate rounded-lg px-2 py-1 text-left text-sm font-medium text-mist-200 hover:bg-ink-850">
                {group.title}
              </button>
              {group.places.map((place) => (
                <div key={key(place)} className="flex items-start gap-2 px-2 py-1" data-mention={key(place)}>
                  <p className="min-w-0 flex-1 text-xs break-words text-mist-500">
                    {place.before.length >= 80 && '…'}
                    {place.before}
                    <mark className="rounded bg-accent-500/20 px-0.5 text-mist-100">{place.words}</mark>
                    {place.after}
                    {refused[key(place)] && <span className="mt-0.5 block text-warn-500">{refused[key(place)]}</span>}
                  </p>
                  <button
                    type="button"
                    disabled={!place.writable || busy === key(place)}
                    title={place.writable ? t('unlinked.linkHint', { link: place.link }) : t('unlinked.readOnly')}
                    onClick={() => void link(place)}
                    className="shrink-0 rounded-md border border-ink-700 px-2 py-0.5 text-xs text-mist-300 hover:border-accent-500 hover:text-mist-100 disabled:opacity-40 disabled:hover:border-ink-700"
                  >
                    {t('unlinked.link')}
                  </button>
                </div>
              ))}
            </div>
          ))}
          {found?.more && <p className="px-2 text-xs text-mist-600">{t('unlinked.more')}</p>}
        </>
      )}
    </section>
  )
}
