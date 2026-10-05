/**
 * The notes nearest in meaning to the one shown (`services/meaning.py`), in the tab "Links" below the unlinked
 * mentions: only where the operator brings one service for all with a model for it, and only notes one may read.
 * Nothing at all while it is off, so that the tab looks as before; not even asked while the operator keeps Lore off.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { loreApi, type SimilarNote } from '../api/client'
import { folderColor } from '../graph/palette'
import { useAuth } from '../state/auth'
import { Symbol } from './Symbol'

export function SimilarNotes({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const asked = Boolean(me?.lore_allowed)
  const [found, setFound] = useState<{ path: string; notes: SimilarNote[] } | null>(null)
  useEffect(() => {
    if (!asked) return
    let current = true
    loreApi.similar(path).then(
      (answer) => current && setFound(answer.on ? { path, notes: answer.notes } : null),
      () => current && setFound(null),
    )
    return () => {
      current = false
    }
  }, [path, asked])
  if (!asked || !found || found.path !== path || !found.notes.length) return null
  return (
    <section className="mt-4" data-testid="similar-notes">
      <h3 className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold tracking-wider text-mist-500 uppercase">
        <Symbol name="sparkle" className="h-3.5 w-3.5" /> {t('lore.similar')}
      </h3>
      {found.notes.map((item) => (
        <button
          key={item.path}
          type="button"
          data-note={item.path}
          onClick={() => onOpen(item.path)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-mist-300 hover:bg-ink-850"
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: folderColor(item.path) }} />
          <span className="truncate">{item.title}</span>
        </button>
      ))}
    </section>
  )
}
