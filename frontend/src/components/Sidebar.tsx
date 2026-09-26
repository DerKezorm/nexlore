/** Folder tree on the left: spaces, folders, notes, and a new note in the folder one is in. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ApiError, vaultApi } from '../api/client'
import { errorText } from '../lib/errors'
import { folderOf, type Cluster } from '../lib/vault'
import { useStore } from '../state/store'
import { Symbol } from './Symbol'

/** A folder shows this many notes at first; the rest on request, so a folder with thousands stays quick. */
const FIRST = 200

type Props = {
  activeNote: string | null
  activeCluster?: string | null
  onNote: (id: string) => void
  onCluster?: (id: string) => void
}

export function Sidebar({ activeNote, activeCluster, onNote, onCluster }: Props) {
  const { t } = useTranslation()
  const { vault, spaces, reload } = useStore()
  const navigate = useNavigate()
  // Spaces and the folder of the active note start open.
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    const start = new Set(vault.root.children.map((c) => c.id))
    for (let c = activeNote ? vault.home.get(activeNote) : null; c; c = c.parent) start.add(c.id)
    return start
  })
  const [full, setFull] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const target = activeNote ? folderOf(activeNote) : activeCluster || spaces[0]?.name

  const toggle = (id: string) =>
    setOpenIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const create = async () => {
    if (!title.trim() || !target) return
    try {
      const note = await vaultApi.create(target, title.trim())
      setCreating(false)
      setTitle('')
      setProblem(null)
      await reload()
      navigate(`/note/${encodeURI(note.path)}?edit=1`)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  const renderCluster = (cluster: Cluster) => {
    const isOpen = openIds.has(cluster.id)
    const shown = full.has(cluster.id) ? cluster.notes : cluster.notes.slice(0, FIRST)
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
            <span className="ml-auto shrink-0 text-[11px] text-mist-600 tabular-nums">{cluster.total}</span>
          </button>
        </div>
        {isOpen && (
          <ul>
            {cluster.children.map(renderCluster)}
            {shown.map((note) => (
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
                  {note.lockedBy && <Symbol name="lock" className="ml-auto h-3.5 w-3.5 shrink-0 text-warn-500" />}
                </button>
              </li>
            ))}
            {shown.length < cluster.notes.length && (
              <li>
                <button
                  type="button"
                  onClick={() => setFull((current) => new Set(current).add(cluster.id))}
                  className="w-full rounded-lg py-1 text-left text-xs text-accent-400 hover:bg-ink-850"
                  style={{ paddingLeft: cluster.depth * 12 + 10 }}
                >
                  {t('sidebar.more', { count: cluster.notes.length - shown.length })}
                </button>
              </li>
            )}
          </ul>
        )}
      </li>
    )
  }

  return (
    <aside className="nn-scroll hidden w-64 shrink-0 overflow-y-auto border-r border-ink-700/80 bg-ink-950/60 px-2 py-3 md:block">
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('sidebar.spaces')}</span>
        <button
          type="button"
          onClick={() => setCreating((value) => !value)}
          disabled={!target}
          className="rounded-md p-1 text-mist-500 hover:bg-ink-850 hover:text-mist-100 disabled:opacity-40"
          title={t('sidebar.newNote')}
          aria-label={t('sidebar.newNote')}
        >
          <Symbol name="plus" className="h-4 w-4" />
        </button>
      </div>
      {creating && target && (
        <form
          className="mb-3 px-2"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setCreating(false)}
            placeholder={t('sidebar.newTitle')}
            aria-label={t('sidebar.newTitle')}
            className="h-8 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 text-[13px] outline-none focus:border-accent-500"
          />
          <p className="mt-1 truncate text-[11px] text-mist-600">{t('sidebar.newIn', { folder: target })}</p>
          {problem && <p className="mt-1 text-[11px] text-bad-500">{errorText(problem)}</p>}
        </form>
      )}
      <ul>{vault.root.children.map(renderCluster)}</ul>
      {vault.root.children.length === 0 && <p className="px-2 text-sm text-mist-500">{t('sidebar.empty')}</p>}
    </aside>
  )
}
