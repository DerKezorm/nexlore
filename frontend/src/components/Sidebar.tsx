/** Folder tree on the left: spaces, folders, notes. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SPACES } from '../mock/notes'
import type { Cluster } from '../lib/vault'
import { useStore } from '../state/store'
import { Symbol } from './Symbol'

type Props = {
  activeNote: string | null
  activeCluster?: string | null
  onNote: (id: string) => void
  onCluster?: (id: string) => void
}

export function Sidebar({ activeNote, activeCluster, onNote, onCluster }: Props) {
  const { t } = useTranslation()
  const { vault } = useStore()
  // Spaces and the folder of the active note start open.
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    const start = new Set(vault.root.children.map((c) => c.id))
    for (let c = activeNote ? vault.home.get(activeNote) : null; c; c = c.parent) start.add(c.id)
    return start
  })

  const toggle = (id: string) =>
    setOpenIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderCluster = (cluster: Cluster) => {
    const isOpen = openIds.has(cluster.id)
    const space = cluster.depth === 1 ? SPACES.find((s) => s.name === cluster.name) : null
    return (
      <li key={cluster.id}>
        <div
          className={
            'group flex items-center gap-1 rounded-lg pr-1.5 ' +
            (activeCluster === cluster.id ? 'bg-accent-500/10 text-accent-400' : 'text-mist-300 hover:bg-ink-850')
          }
          style={{ paddingLeft: (cluster.depth - 1) * 12 + 4 }}
        >
          <button type="button" onClick={() => toggle(cluster.id)} className="rounded p-1 text-mist-600 hover:text-mist-100" aria-label={isOpen ? t('sidebar.collapse') : t('sidebar.expand')}>
            <Symbol name={isOpen ? 'chevronDown' : 'chevronRight'} className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => (onCluster ? onCluster(cluster.id) : toggle(cluster.id))}
            className={'flex min-w-0 flex-1 items-center gap-2 py-1 text-left ' + (cluster.depth === 1 ? 'text-[13px] font-semibold text-mist-100' : 'text-[13px]')}
            title={onCluster ? t('sidebar.flyTo') : undefined}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: cluster.color }} />
            <span className="truncate">{cluster.name}</span>
            {space?.shared && (
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-ink-800 px-1.5 text-[10px] font-medium text-mist-400" title={space.members.join(', ')}>
                <Symbol name="users" className="h-3 w-3" />
                {space.members.length}
              </span>
            )}
            {!space && <span className="ml-auto shrink-0 text-[11px] text-mist-600 tabular-nums">{cluster.total}</span>}
          </button>
        </div>
        {isOpen && (
          <ul>
            {cluster.children.map(renderCluster)}
            {cluster.notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => onNote(note.id)}
                  className={
                    'flex w-full items-center gap-2 rounded-lg py-1 pr-2 text-left text-[13px] ' +
                    (activeNote === note.id ? 'bg-accent-500/15 text-accent-400' : 'text-mist-400 hover:bg-ink-850 hover:text-mist-100')
                  }
                  style={{ paddingLeft: cluster.depth * 12 + 10 }}
                >
                  <Symbol name="note" className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  <span className="truncate">{note.title}</span>
                  {note.aiDraft && <Symbol name="sparkle" className="ml-auto h-3.5 w-3.5 shrink-0 text-ai-500" />}
                  {note.lockedBy && <Symbol name="lock" className="ml-auto h-3.5 w-3.5 shrink-0 text-warn-500" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <aside className="nn-scroll hidden w-64 shrink-0 overflow-y-auto border-r border-ink-700/80 bg-ink-950/60 px-2 py-3 md:block">
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('sidebar.spaces')}</span>
        <button type="button" className="rounded-md p-1 text-mist-500 hover:bg-ink-850 hover:text-mist-100" title={t('sidebar.newNote')}>
          <Symbol name="plus" className="h-4 w-4" />
        </button>
      </div>
      <ul>{vault.root.children.map(renderCluster)}</ul>
    </aside>
  )
}
