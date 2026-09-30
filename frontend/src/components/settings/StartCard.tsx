/**
 * Settings → General: the page nexlore opens on, for the own account (Obsidian's Homepage plugin): the map, today's
 * daily note, the note opened last, or one note chosen here. `lib/start.ts` goes there once per tab.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { vaultApi, type Found } from '../../api/client'
import { DEFAULT_APPEARANCE, type Start } from '../../lib/appearance'
import { homeSpace } from '../../lib/everyday'
import { useAuth } from '../../state/auth'
import { useStore } from '../../state/store'
import { Card } from './ui'

const STARTS: Start[] = ['graph', 'daily', 'last', 'note']

export function StartCard() {
  const { t } = useTranslation()
  const { me, setAppearance } = useAuth()
  const look = me?.appearance ?? DEFAULT_APPEARANCE
  // "One note" shows the picker; it is stored only once a note is chosen.
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Found[]>([])
  const chosen = picking || look.start === 'note' ? 'note' : look.start

  useEffect(() => {
    if (!picking) return
    let live = true
    const timer = window.setTimeout(() => {
      vaultApi
        .find(query.trim(), undefined, 8)
        .then((hits) => live && setFound(hits))
        .catch(() => live && setFound([]))
    }, 150)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [picking, query])

  const choose = (start: Start) => {
    if (start === 'note') return setPicking(true)
    setPicking(false)
    void setAppearance({ start })
  }

  return (
    <Card symbol="home" title={t('start.title')} text={t('start.text')} id="start">
      <div className="grid gap-2" role="radiogroup" aria-label={t('start.title')}>
        {STARTS.map((start) => (
          <label key={start} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm">
            <input type="radio" name="start" checked={chosen === start} onChange={() => choose(start)} className="accent-accent-500" />
            <span className="flex-1">{t(`start.${start}`)}</span>
            {start === 'note' && look.start === 'note' && look.start_note && !picking && (
              <span className="truncate text-xs text-mist-500" data-testid="start-note">
                {look.start_note.replace(/\.md$/i, '').replace(/\//g, ' › ')}
              </span>
            )}
          </label>
        ))}
      </div>
      {chosen === 'note' && (
        <div className="mt-3 grid gap-2">
          {!picking && look.start_note ? (
            <button type="button" onClick={() => setPicking(true)} className="justify-self-start text-sm text-accent-400 hover:underline">
              {t('start.other')}
            </button>
          ) : (
            <>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('start.find')}
                aria-label={t('start.find')}
                autoFocus
                className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-mist-100"
              />
              <ul className="grid gap-1" aria-label={t('start.found')}>
                {found.map((note) => (
                  <li key={note.path}>
                    <button
                      type="button"
                      onClick={() => {
                        setPicking(false)
                        setQuery('')
                        void setAppearance({ start: 'note', start_note: note.path })
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm text-mist-300 hover:bg-ink-850"
                    >
                      <span className="truncate font-medium text-mist-100">{note.title}</span>
                      <span className="truncate text-xs text-mist-500">{note.path.replace(/\/[^/]*$/, '').replace(/\//g, ' › ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Card>
  )
}

/** Settings → General: where "Today", quick capture and a new note go when no note of a space is open (P5.19). */
export function HomeSpaceCard() {
  const { t } = useTranslation()
  const { me, setAppearance } = useAuth()
  const { spaces } = useStore()
  const writable = spaces.filter((space) => space.role === 'write' || space.role === 'manage')
  const chosen = me?.appearance?.home_space ?? ''
  const fallback = homeSpace(spaces)?.name ?? ''
  if (!writable.length) return null
  return (
    <Card symbol="folder" title={t('homeSpace.title')} text={t('homeSpace.text')} id="home-space">
      <label className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
        <span className="font-medium">{t('homeSpace.choose')}</span>
        <select
          value={writable.some((space) => space.name === chosen) ? chosen : ''}
          onChange={(event) => void setAppearance({ home_space: event.target.value })}
          className="rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-mist-100"
        >
          <option value="">{t('homeSpace.first', { space: fallback })}</option>
          {writable.map((space) => (
            <option key={space.id} value={space.name}>
              {space.name}
            </option>
          ))}
        </select>
      </label>
    </Card>
  )
}
