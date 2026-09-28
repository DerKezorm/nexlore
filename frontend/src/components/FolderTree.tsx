/**
 * Folders to pick one from: the spaces given, each opened one level at a time as it is asked for (a space can hold
 * thousands of folders, none is read before it is opened). The folders on the way to the chosen one start open.
 * Used by "Move" (the folders of one space) and "New note" (every space one may write in).
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { vaultApi, type FolderEntry } from '../api/client'
import { Symbol } from './Symbol'

type Props = {
  roots: string[]
  selected: string | null
  onSelect: (path: string) => void
  /** A folder that cannot be chosen (the one a note is in already, the moved folder itself); shown, greyed. */
  blocked?: (path: string) => boolean
  /** A folder left out with everything in it (a folder cannot move into itself). */
  hidden?: (path: string) => boolean
}

export function FolderTree({ roots, selected, onSelect, blocked = () => false, hidden = () => false }: Props) {
  const { t } = useTranslation()
  const [children, setChildren] = useState<Map<string, FolderEntry[] | 'loading' | 'failed'>>(new Map())
  const [open, setOpen] = useState<Set<string>>(() => {
    const start = new Set<string>(roots.length === 1 ? roots : [])
    if (selected) {
      const parts = selected.split('/')
      for (let i = 1; i < parts.length; i++) start.add(parts.slice(0, i).join('/'))
    }
    return start
  })

  const load = useCallback((at: string) => {
    setChildren((current) => new Map(current).set(at, 'loading'))
    vaultApi.folder(at, 0, 1).then(
      (listing) => setChildren((current) => new Map(current).set(at, listing.folders)),
      () => setChildren((current) => new Map(current).set(at, 'failed')),
    )
  }, [])
  // Whatever starts open is read once.
  useEffect(() => {
    for (const at of open) load(at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (at: string, expanded: boolean) => {
    setOpen((current) => {
      const next = new Set(current)
      if (expanded) next.delete(at)
      else next.add(at)
      return next
    })
    const list = children.get(at)
    if (!expanded && (list === undefined || list === 'failed')) load(at)
  }

  const row = (at: string, name: string, depth: number) => {
    const list = children.get(at)
    const expanded = open.has(at)
    return (
      <li key={at}>
        <div className="flex items-center gap-1" style={{ paddingLeft: depth * 14 }}>
          <button
            type="button"
            aria-label={`${expanded ? t('sidebar.collapse') : t('sidebar.expand')} ${name}`}
            onClick={() => toggle(at, expanded)}
            className="rounded p-1 text-mist-600 hover:text-mist-100"
          >
            <Symbol name={expanded ? 'chevronDown' : 'chevronRight'} className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={blocked(at)}
            aria-pressed={selected === at}
            onClick={() => onSelect(at)}
            className={
              'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm disabled:opacity-40 ' +
              (selected === at ? 'bg-accent-500/15 text-accent-400' : 'hover:bg-ink-850')
            }
          >
            <Symbol name={depth === 0 ? 'space' : 'folder'} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{name}</span>
          </button>
        </div>
        {expanded && (
          <ul>
            {list === 'loading' || list === undefined ? (
              <li className="py-1 text-xs text-mist-600" style={{ paddingLeft: depth * 14 + 30 }}>{t('common.loading')}</li>
            ) : list === 'failed' ? (
              <li className="py-1 text-xs text-bad-500" style={{ paddingLeft: depth * 14 + 30 }}>{t('sidebar.loadFailed')}</li>
            ) : (
              list.filter((entry) => !hidden(entry.path)).map((entry) => row(entry.path, entry.name, depth + 1))
            )}
          </ul>
        )}
      </li>
    )
  }

  return <ul className="max-h-72 overflow-y-auto rounded-xl border border-ink-700 p-1.5">{roots.map((root) => row(root, root, 0))}</ul>
}
