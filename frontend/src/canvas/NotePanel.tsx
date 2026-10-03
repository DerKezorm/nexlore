/**
 * A note beside the canvas: the note page's editor, with the lock, the saving and the conflict copy the note page
 * has (`useEditedFile`). The card on the canvas shows the new text once it is saved.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { vaultApi } from '../api/client'
import { NoteEditor, type EditorHandle } from '../components/NoteEditor'
import { Symbol } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { LinkIndex } from '../lib/links'
import { noteUrl } from '../lib/vault'
import { useStore } from '../state/store'
import { useEditedFile, type FileBackend } from './useEditedFile'

type Props = {
  path: string
  onClose: () => void
  /** The note was saved: its card loads it again. */
  onSaved: (path: string) => void
  /** A link in the note: the note it leads to, here instead. */
  onOpenNote: (path: string) => void
}

export function NotePanel({ path, onClose, onSaved, onOpenNote }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { spaces } = useStore()
  const role = spaces.find((space) => space.name === path.split('/')[0])?.role
  const backend = useMemo<FileBackend>(
    () => ({
      load: () => vaultApi.note(path).then((note) => ({ content: note.content, hash: note.hash, lock: note.lock, readonly: note.readonly })),
      state: () => vaultApi.noteState(path),
      save: (content, baseHash, keepalive) => vaultApi.save(path, content, baseHash, keepalive),
    }),
    [path],
  )
  const file = useEditedFile(path, backend, role === 'write' || role === 'manage')
  const editor = useRef<EditorHandle>(null)
  const links = useMemo(() => new LinkIndex(path), [path])

  // Loaded again (saved elsewhere, a conflict): the editor shows the note as it is now.
  const shown = useRef(0)
  useEffect(() => {
    if (shown.current && file.version !== shown.current) editor.current?.replace(file.content)
    shown.current = file.version
  }, [file.version, file.content])

  // Saved: the card shows the new text.
  const wasDirty = useRef(false)
  useEffect(() => {
    if (wasDirty.current && !file.dirty) onSaved(path)
    wasDirty.current = file.dirty
  }, [file.dirty, onSaved, path])

  const title = (path.split('/').pop() ?? '').replace(/\.md$/i, '')
  const close = () => void file.flush().finally(onClose)
  return (
    <aside aria-label={t('canvas.panel', { name: title })} className="flex w-[470px] max-w-full shrink-0 flex-col border-l border-ink-700 bg-ink-900 max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-auto">
      <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2.5">
        <Symbol name="note" className="h-4 w-4 shrink-0 text-accent-400" />
        <b className="min-w-0 flex-1 truncate">{title}</b>
        <span className="shrink-0 text-xs text-mist-500" aria-live="polite">
          {file.dirty ? t('canvas.saving') : t('canvas.saved')}
        </span>
        <button
          type="button"
          onClick={() => void file.flush().finally(() => navigate(noteUrl(path)))}
          className="shrink-0 rounded-full border border-ink-600 px-3 py-1 text-xs text-mist-300 hover:bg-ink-850"
        >
          {t('canvas.openPage')}
        </button>
        <button type="button" onClick={close} title={t('common.close')} aria-label={t('common.close')} className="grid h-8 w-8 place-items-center rounded-lg text-mist-400 hover:bg-ink-850">
          <Symbol name="close" className="h-4 w-4" />
        </button>
      </div>
      {file.lockedBy && <p className="border-b border-warn-500/30 bg-warn-500/10 px-4 py-2 text-sm text-warn-500">{t('canvas.noteLocked', { name: file.lockedBy })}</p>}
      {file.conflict && (
        <p className="border-b border-warn-500/30 bg-warn-500/10 px-4 py-2 text-sm text-warn-500">
          {t('canvas.conflict')}{' '}
          <button type="button" className="underline" onClick={() => navigate(noteUrl(file.conflict!))}>
            {t('canvas.showCopy')}
          </button>
        </p>
      )}
      {file.error && <p className="border-b border-bad-500/30 bg-bad-500/10 px-4 py-2 text-sm text-bad-500" role="alert">{errorText(file.error)}</p>}
      <div className="nn-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {file.status === 'ready' && (
          <NoteEditor
            key={path}
            ref={editor}
            path={path}
            content={file.content}
            links={links}
            mode="visual"
            readOnly={file.readonly}
            onChange={() => editor.current && file.change(editor.current.text())}
            onLeave={(text) => file.change(text)}
            onOpenLink={(target) => {
              const found = links.resolve(target)
              if (found) onOpenNote(found)
            }}
          />
        )}
        {file.status === 'loading' && <p className="text-sm text-mist-500">{t('common.loading')}</p>}
      </div>
    </aside>
  )
}
