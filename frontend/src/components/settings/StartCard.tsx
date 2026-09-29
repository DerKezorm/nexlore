/**
 * Settings → General: the page nexlore opens on, for the own account (Obsidian's Homepage plugin): the map, today's
 * daily note, the note opened last, or one note chosen here. `lib/start.ts` goes there once per tab.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { vaultApi, type Found } from '../../api/client'
import { DEFAULT_APPEARANCE, type Start } from '../../lib/appearance'
import { useAuth } from '../../state/auth'
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
