/**
 * The tags of every readable note as a tree, as in Obsidian's tag pane: `#project/garden` sits under `#project`, each
 * with how many notes carry it (a tag above counts the ones below it too). A click shows its notes; the context menu
 * renames it everywhere the account may write (the dialog lives in the app's frame).
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { tagsApi, type NoteRef, type TagCount } from '../api/client'
import { tagTree, type TagNode } from '../lib/tags'
import { folderColor } from '../graph/palette'
import { menuTriggers, useContextMenu } from '../lib/menu'
import { askVaultAction } from '../lib/vaultActions'
import { useStore } from '../state/store'
import { Symbol } from './Symbol'

export function TagTree({ activeNote, onNote }: { activeNote: string | null; onNote: (path: string) => void }) {
  const { t } = useTranslation()
  const { generation } = useStore()
  const menu = useContextMenu()
  const [tags, setTags] = useState<TagCount[] | null | 'failed'>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState<Map<string, NoteRef[] | 'loading'>>(new Map())

  useEffect(() => {
    let live = true
    tagsApi.list().then(
      (found) => live && setTags(found),
      () => live && setTags('failed'),
    )
    // A rename or a save changes the tags: the notes shown under a tag are asked again when it is opened.
    setNotes(new Map())
    return () => {
      live = false
    }
  }, [generation])

  const tree = useMemo(() => (Array.isArray(tags) ? tagTree(tags) : []), [tags])

  const toggle = (node: TagNode) => {
    const next = new Set(open)
    if (next.has(node.tag)) next.delete(node.tag)
    else {
      next.add(node.tag)
      if (!notes.has(node.tag)) {
        setNotes((map) => new Map(map).set(node.tag, 'loading'))
        tagsApi.notes(node.tag, node.children.length > 0).then(
          (found) => setNotes((map) => new Map(map).set(node.tag, found)),
          () => setNotes((map) => new Map(map).set(node.tag, [])),
        )
      }
    }
    setOpen(next)
  }

  const row = (node: TagNode, depth: number) => {
    const expanded = open.has(node.tag)
    const listed = notes.get(node.tag)
    // Under a tag with tags below it: the notes that carry this one itself (the others are under the tags below).
    return (
      <li key={node.tag}>
        <button
          type="button"
          onClick={() => toggle(node)}
          aria-expanded={expanded}
          {...menuTriggers((x, y) =>
            menu.open(x, y, [
              { label: t('tags.rename'), symbol: 'pencil', onSelect: () => askVaultAction({ kind: 'rename-tag', tag: node.tag }) },
            ]),
          )}
          className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-[13px] text-mist-300 hover:bg-ink-850"
          style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
        >
          <Symbol name={expanded ? 'chevronDown' : 'chevronRight'} className="h-3.5 w-3.5 shrink-0 text-mist-600" />
          <span className="text-mist-600">#</span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="shrink-0 text-[11px] text-mist-600 tabular-nums">{node.total}</span>
        </button>
        {expanded && (
          <>
            {node.children.length > 0 && <ul>{node.children.map((child) => row(child, depth + 1))}</ul>}
            {listed === 'loading' ? (
              <p className="py-1 text-xs text-mist-600" style={{ paddingLeft: `${1.9 + depth * 0.9}rem` }}>{t('tags.loading')}</p>
            ) : listed && listed.length === 0 ? (
              <p className="py-1 text-xs text-mist-600" style={{ paddingLeft: `${1.9 + depth * 0.9}rem` }}>{t('tags.noNotes')}</p>
            ) : (
              <ul>
                {(listed ?? []).map((note) => (
                  <li key={note.path}>
                    <button
                      type="button"
                      onClick={() => onNote(note.path)}
                      title={note.path}
                      className={'flex w-full items-center gap-2 rounded-lg py-1 pr-2 text-left text-[13px] hover:bg-ink-850 ' + (note.path === activeNote ? 'bg-accent-500/10 text-accent-300' : 'text-mist-400')}
                      style={{ paddingLeft: `${1.9 + depth * 0.9}rem` }}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: folderColor(note.path) }} />
                      <span className="min-w-0 flex-1 truncate">{note.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </li>
    )
  }

  return (
    <div className="nn-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-testid="tag-tree">
      {tags === null ? (
        <p className="px-2 text-sm text-mist-500">{t('tags.loading')}</p>
      ) : tags === 'failed' ? (
        <p className="px-2 text-sm text-bad-500">{t('tags.failed')}</p>
      ) : tree.length === 0 ? (
        <p className="px-2 text-sm text-mist-500">{t('tags.empty')}</p>
      ) : (
        <ul>{tree.map((node) => row(node, 0))}</ul>
      )}
      {menu.element}
    </div>
  )
}
