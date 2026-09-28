/**
 * The dialogs behind the context menus of the sidebar: a new folder, renaming and moving a note or folder (links to it
 * follow, in every space), and the trash. Asked for through `askVaultAction`; they live in the app's frame.
 *
 * Before a note or folder moves or goes, the page showing it is told (`announceLeaving`): it saves what is being typed
 * and stops asking after the old path. A page that stood on it moves along to the new one, or back to the notes.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { ApiError, vaultApi } from '../api/client'
import { errorText } from '../lib/errors'
import { fileRoute } from '../lib/markdown'
import { baseName, folderOf, noteUrl } from '../lib/vault'
import { announceLeaving, forget, reveal, VAULT_ACTION_EVENT, within, type VaultAction } from '../lib/vaultActions'
import { useStore } from '../state/store'
import { ConfirmDialog } from './ConfirmDialog'
import { FolderTree } from './FolderTree'
import { Symbol } from './Symbol'

/** The note or folder the address stands on, as a vault path (`/note/…`, `/file/…`), or null. */
function shownPath(pathname: string): string | null {
  const found = /^\/(?:note|file)\/(.+)$/.exec(pathname)
  return found ? found[1].split('/').map(decodeURIComponent).join('/') : null
}

export function VaultActions() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { reload } = useStore()
  const [action, setAction] = useState<VaultAction | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const here = useRef<string | null>(null)
  here.current = shownPath(location.pathname)

  useEffect(() => {
    const ask = (event: Event) => setAction((event as CustomEvent<VaultAction>).detail)
    window.addEventListener(VAULT_ACTION_EVENT, ask)
    return () => window.removeEventListener(VAULT_ACTION_EVENT, ask)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const close = useCallback(() => setAction(null), [])

  /** Moves `path` to `destination`; the page follows if it stood on it or inside it. */
  const moveTo = async (path: string, destination: string) => {
    const affected = here.current !== null && within(here.current, path)
    if (affected) await announceLeaving(here.current!)
    const moved = await vaultApi.move(path, destination)
    forget(path)
    await reload()
    reveal(folderOf(moved.path))
    if (affected && here.current) {
      const next = moved.path + here.current.slice(path.length)
      navigate(location.pathname.startsWith('/file/') ? fileRoute(next) : noteUrl(next))
    }
    return moved
  }

  const trash = async (path: string, along: string[]) => {
    const affected = here.current !== null && within(here.current, path)
    if (affected) await announceLeaving(here.current!)
    await vaultApi.remove(path, along)
    forget(path)
    await reload()
    if (affected) navigate('/note')
  }

  if (!action) return notice ? <Notice text={notice} /> : null
  const done = (text: string | null) => {
    setAction(null)
    if (text) setNotice(text)
  }

  return (
    <>
      {action.kind === 'new-space' && (
        <NameDialog
          title={t('actions.newSpaceTitle')}
          hint={t('actions.newSpaceHint')}
          confirm={t('actions.create')}
          initial=""
          onClose={close}
          onSubmit={async (name) => {
            const made = await vaultApi.createSpace(name)
            await reload()
            reveal(made.name)
            done(t('actions.spaceMade', { name: made.name }))
          }}
        />
      )}
      {action.kind === 'new-folder' && (
        <NameDialog
          title={t('actions.newFolderTitle', { folder: action.parent.split('/').join(' / ') })}
          confirm={t('actions.create')}
          initial=""
          onClose={close}
          onSubmit={async (name) => {
            const made = await vaultApi.createFolder(action.parent, name)
            await reload()
            reveal(made.path)
            done(t('actions.folderMade', { name }))
          }}
        />
      )}
      {action.kind === 'rename' && (
        <NameDialog
          title={t('actions.renameTitle', { name: baseName(action.path) })}
          hint={t('actions.renameHint')}
          confirm={t('actions.renameDo')}
          initial={baseName(action.path)}
          onClose={close}
          onSubmit={async (name) => {
            const moved = await moveTo(action.path, `${folderOf(action.path)}/${name}${action.folder ? '' : '.md'}`)
            done(moved.rewritten > 0 ? t('note.linksFollowed', { count: moved.rewritten }) : null)
          }}
        />
      )}
      {action.kind === 'move' && (
        <MoveDialog
          path={action.path}
          folder={action.folder}
          onClose={close}
          onMove={async (target) => {
            const name = action.path.slice(action.path.lastIndexOf('/') + 1)
            const moved = await moveTo(action.path, `${target}/${name}`)
            done(
              t('actions.moved', { folder: target.split('/').join(' / ') }) +
                (moved.rewritten > 0 ? ' ' + t('note.linksFollowed', { count: moved.rewritten }) : ''),
            )
          }}
        />
      )}
      {action.kind === 'delete' && <TrashDialog path={action.path} folder={action.folder} onClose={close} onTrash={async (along) => { await trash(action.path, along); done(null) }} />}
    </>
  )
}

function Notice({ text }: { text: string }) {
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-40 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full border border-ink-700 bg-ink-900 px-4 py-2 text-sm text-mist-200 shadow-lg">
      {text}
    </div>
  )
}

/** A dialog of nexlore's own around a form; Escape and the close button cancel. */
function Frame({ title, children, onClose, onSubmit, testId }: { title: string; children: ReactNode; onClose: () => void; onSubmit: () => void; testId: string }) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      data-testid={testId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(30rem,calc(100vw-1.5rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <form
        className="flex max-h-[85vh] flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="flex items-start gap-3 border-b border-ink-700 px-4 py-3">
          <h2 className="min-w-0 flex-1 text-base font-semibold break-words text-mist-100">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-full p-1 text-mist-500 hover:bg-ink-850">
            <Symbol name="close" />
          </button>
        </div>
        {children}
      </form>
    </dialog>
  )
}

function Buttons({ confirm, busy, disabled = false, onClose }: { confirm: string; busy: boolean; disabled?: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-3">
      <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-mist-400 hover:text-mist-100">
        {t('common.cancel')}
      </button>
      <button type="submit" disabled={busy || disabled} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40">
        {confirm}
      </button>
    </div>
  )
}

function useSubmit(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await run()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }
  return { busy, problem, submit }
}

function NameDialog({ title, hint, confirm, initial, onClose, onSubmit }: { title: string; hint?: string; confirm: string; initial: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial)
  const { busy, problem, submit } = useSubmit(() => onSubmit(name.trim()))
  const unchanged = !name.trim() || name.trim() === initial
  return (
    <Frame title={title} onClose={onClose} onSubmit={() => !unchanged && void submit()} testId="name-dialog">
      <div className="space-y-2 p-4">
        <label className="block text-sm">
          <span className="text-xs text-mist-500">{t('actions.name')}</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.target.select()}
            className="mt-1 h-9 w-full rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-mist-100 outline-none focus:border-accent-500"
          />
        </label>
        {hint && <p className="text-xs text-mist-500">{hint}</p>}
        {problem && <p role="alert" className="text-sm text-bad-500">{errorText(problem)}</p>}
      </div>
      <Buttons confirm={confirm} busy={busy} disabled={unchanged} onClose={onClose} />
    </Frame>
  )
}

/** The folders of the space; the item itself and what lies in it cannot be the target. */
function MoveDialog({ path, folder, onClose, onMove }: { path: string; folder: boolean; onClose: () => void; onMove: (target: string) => Promise<void> }) {
  const { t } = useTranslation()
  const [target, setTarget] = useState<string | null>(null)
  const { busy, problem, submit } = useSubmit(() => onMove(target!))
  return (
    <Frame title={t('actions.moveTitle', { name: baseName(path) })} onClose={onClose} onSubmit={() => target && void submit()} testId="move-dialog">
      <div className="min-h-0 space-y-2 overflow-y-auto p-4">
        <p className="text-xs text-mist-500">{t('actions.moveHint')}</p>
        <FolderTree
          roots={[path.split('/')[0]]}
          selected={target}
          onSelect={setTarget}
          blocked={(at) => at === folderOf(path) || (folder && within(at, path))}
          hidden={(at) => folder && at === path}
        />
        {problem && <p role="alert" className="text-sm text-bad-500">{errorText(problem)}</p>}
      </div>
      <Buttons confirm={t('actions.moveHere')} busy={busy} disabled={!target} onClose={onClose} />
    </Frame>
  )
}

/** The trash for a note (with the files only it uses, as on the note page) or a whole folder. */
function TrashDialog({ path, folder, onClose, onTrash }: { path: string; folder: boolean; onClose: () => void; onTrash: (along: string[]) => Promise<void> }) {
  const { t } = useTranslation()
  const [own, setOwn] = useState<string[]>([])
  const [withOwn, setWithOwn] = useState(true)
  const { busy, problem, submit } = useSubmit(() => onTrash(withOwn ? own : []))
  useEffect(() => {
    if (folder) return
    let live = true
    vaultApi.own(path).then(
      (found) => live && setOwn(found.paths),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [path, folder])
  return (
    <ConfirmDialog
      open
      title={folder ? t('actions.trashFolderTitle', { name: baseName(path) }) : t('note.deleteTitle', { title: baseName(path) })}
      confirm={t('note.deleteDo')}
      danger
      busy={busy}
      onCancel={onClose}
      onConfirm={() => void submit()}
    >
      {folder ? t('actions.trashFolderText') : t('note.deleteText')}
      {!folder && own.length > 0 && (
        <label className="mt-3 flex items-start gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-mist-200">
          <input type="checkbox" checked={withOwn} onChange={(event) => setWithOwn(event.target.checked)} className="mt-1 accent-accent-500" />
          <span>{t('note.deleteOwn', { count: own.length })}</span>
        </label>
      )}
      {problem && <p role="alert" className="mt-2 text-sm text-bad-500">{errorText(problem)}</p>}
    </ConfirmDialog>
  )
}
