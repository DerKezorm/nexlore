/**
 * The note page without a note: a way on instead of a hint. The list of notes (on a phone a sheet), the search, a
 * new note, and the notes changed last and the favorites to pick from.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { vaultApi, type Found } from '../api/client'
import { folderColor } from '../graph/palette'
import { dailySpace } from '../lib/everyday'
import { askNewNote } from '../lib/newNote'
import { askNoteList, askSearch } from '../lib/shell'
import { folderOf } from '../lib/vault'
import { useStore } from '../state/store'
import { Symbol } from './Symbol'

const button = 'inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-850 px-3.5 py-2 text-sm text-mist-200 hover:border-ink-600 hover:text-mist-100'

export function NoteStart({ onNote }: { onNote: (path: string) => void }) {
  const { t } = useTranslation()
  const { spaces, favorites } = useStore()
  const [recent, setRecent] = useState<Found[] | null>(null)
  useEffect(() => {
    let live = true
    // No words: the notes changed last, as the quick switcher shows them.
    vaultApi.find('', undefined, 8).then(
      (found) => live && setRecent(found),
      () => live && setRecent([]),
    )
    return () => {
      live = false
    }
  }, [])
  const home = dailySpace(spaces)
  const notes = favorites.filter((favorite) => favorite.kind === 'note')
  const row = (path: string, title: string) => (
    <li key={path}>
      <button type="button" onClick={() => onNote(path)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-mist-300 hover:bg-ink-850 hover:text-mist-100">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: folderColor(path) }} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="hidden max-w-[45%] truncate text-xs text-mist-600 sm:inline">{folderOf(path).replace(/\//g, ' › ')}</span>
      </button>
    </li>
  )
  return (
    <main className="nn-scroll flex flex-1 justify-center overflow-y-auto px-4 py-10 sm:px-6" data-testid="note-start">
      <div className="flex w-full max-w-lg flex-col gap-8">
        <div className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold text-mist-100">{t('noteStart.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={askNoteList} className={button + ' md:hidden'}>
              <Symbol name="note" /> {t('noteStart.list')}
            </button>
            <button type="button" onClick={askSearch} className={button}>
              <Symbol name="search" /> {t('search.button')}
            </button>
            {home && (
              <button type="button" onClick={() => askNewNote(home.name)} className={button}>
                <Symbol name="plus" /> {t('sidebar.newNote')}
              </button>
            )}
          </div>
        </div>
        {notes.length > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="px-2 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('sidebar.favorites')}</h2>
            <ul>{notes.map((favorite) => row(favorite.path, favorite.title))}</ul>
          </section>
        )}
        <section className="flex flex-col gap-1" aria-busy={recent === null}>
          <h2 className="px-2 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('noteStart.recent')}</h2>
          {recent === null ? (
            <p className="px-2 text-sm text-mist-500">{t('common.loading')}</p>
          ) : recent.length ? (
            <ul>{recent.map((found) => row(found.path, found.title))}</ul>
          ) : (
            <p className="px-2 text-sm text-mist-500">{t('noteStart.none')}</p>
          )}
        </section>
      </div>
    </main>
  )
}
