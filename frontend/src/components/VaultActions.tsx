/**
 * The dialogs behind the context menus of the sidebar: a new folder, renaming and moving a note or folder (links to it
 * follow, in every space), and the trash. Asked for through `askVaultAction`; they live in the app's frame.
 *
 * Before a note or folder moves or goes, the page showing it is told (`announceLeaving`): it saves what is being typed
 * and stops asking after the old path. A page that stood on it moves along to the new one, or back to the notes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { ApiError, basesApi, canvasApi, everydayApi, looksApi, shareApi, tagsApi, vaultApi } from '../api/client'
import { errorText } from '../lib/errors'
import { ensureFolder } from '../lib/folders'
import { fileRoute } from '../lib/markdown'
import { baseName, decodedOrNull, folderOf, noteUrl } from '../lib/vault'
import { announceLeaving, forget, reveal, VAULT_ACTION_EVENT, within, type VaultAction } from '../lib/vaultActions'
import { useStore } from '../state/store'
import type { SymbolName } from '../lib/symbols'
import { ConfirmDialog } from './ConfirmDialog'
import { FolderTree } from './FolderTree'
import { isLucide, searchLucide, useLucide } from '../lib/lucide'
import { LookIcon } from './LookIcon'
import { Symbol } from './Symbol'
import { TrashWarnings } from './TrashWarnings'

/** The note or folder the address stands on, as a vault path (`/note/…`, `/file/…`), or null. */
function shownPath(pathname: string): string | null {
  const found = /^\/(?:note|file)\/(.+)$/.exec(pathname)
  return found ? decodedOrNull(found[1]) : null
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

  /** Moves `path` to `destination`; the page follows if it stood on it or inside it. */
  const moveTo = async (path: string, destination: string, how = vaultApi.move) => {
    const affected = here.current !== null && within(here.current, path)
    if (affected) await announceLeaving(here.current!)
    const moved = await how(path, destination)
    forget(path)
    await reload()
    reveal(moved.path.includes('/') ? folderOf(moved.path) : moved.path)
    if (affected && here.current) {
      const next = moved.path + here.current.slice(path.length)
      navigate(location.pathname.startsWith('/file/') ? fileRoute(next) : noteUrl(next))
    }
    return moved
  }

  // The listener stays for the life of the frame; it reaches the move of the latest render through this.
  const latestMove = useRef(moveTo)
  latestMove.current = moveTo
  useEffect(() => {
    const ask = (event: Event) => {
      const asked = (event as CustomEvent<VaultAction>).detail
      if (asked.kind !== 'move-to') return setAction(asked)
      const name = asked.path.slice(asked.path.lastIndexOf('/') + 1)
      void latestMove.current(asked.path, `${asked.target}/${name}`).then(
        (moved) =>
          setNotice(
            t('actions.moved', { folder: asked.target.split('/').join(' / ') }) +
              (moved.rewritten > 0 ? ' ' + t('note.linksFollowed', { count: moved.rewritten }) : ''),
          ),
        (error: unknown) => setNotice(errorText(error instanceof ApiError ? error.code : 'internal_error')),
      )
    }
    window.addEventListener(VAULT_ACTION_EVENT, ask)
    return () => window.removeEventListener(VAULT_ACTION_EVENT, ask)
  }, [t])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const close = useCallback(() => setAction(null), [])

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
      {action.kind === 'rename-tag' && (
        <NameDialog
          title={t('tags.renameTitle', { tag: action.tag })}
          hint={t('tags.renameHint')}
          confirm={t('actions.renameDo')}
          initial={action.tag}
          onClose={close}
          onSubmit={async (name) => {
            const renamed = await tagsApi.rename(action.tag, name.replace(/^#/, ''))
            await reload()
            const parts = [t('tags.renamed', { count: renamed.changed })]
            if (renamed.locked) parts.push(t('tags.renamedLocked', { count: renamed.locked }))
            if (renamed.read_only) parts.push(t('tags.renamedReadOnly', { count: renamed.read_only }))
            done(parts.join(' '))
          }}
        />
      )}
      {action.kind === 'as-template' && (
        <ConfirmDialog
          open
          title={t('actions.asTemplateTitle', { name: baseName(action.path) })}
          confirm={t('actions.asTemplateDo')}
          onCancel={close}
          onConfirm={() =>
            void (async () => {
              const space = action.path.split('/')[0]
              const [note, options] = await Promise.all([vaultApi.note(action.path), everydayApi.options(space)])
              const folder = `${space}/${options.template_folder}`
              await ensureFolder(folder)
              await vaultApi.create(folder, baseName(action.path), note.content)
              await reload()
              reveal(folder)
              done(t('actions.asTemplateDone', { folder: folder.split('/').join(' / ') }))
            })().catch(() => done(t('actions.asTemplateFailed')))
          }
        >
          {t('actions.asTemplateText')}
        </ConfirmDialog>
      )}
      {action.kind === 'look' && (
        <LookDialog
          path={action.path}
          onClose={close}
          onSave={async (icon, color) => {
            await looksApi.put(action.path, icon, color)
            await reload()
            done(t('looks.saved'))
          }}
        />
      )}
      {action.kind === 'new-space' && (
        <NameDialog
          title={t('actions.newSpaceTitle')}
          hint={t('actions.newSpaceHint')}
          confirm={t('actions.create')}
          initial=""
          look
          onClose={close}
          onSubmit={async (name, icon, color) => {
            const made = await vaultApi.createSpace(name)
            const looked = await lookOf(made.name, icon, color)
            await reload()
            reveal(made.name)
            done(t('actions.spaceMade', { name: made.name }) + (looked ? '' : ' ' + t('looks.notSaved')))
          }}
        />
      )}
      {action.kind === 'new-base' && (
        <NameDialog
          title={t('bases.newTitle', { folder: action.folder.split('/').join(' / ') })}
          hint={t('bases.newHint')}
          confirm={t('actions.create')}
          initial=""
          onClose={close}
          onSubmit={async (name) => {
            const made = await basesApi.create(action.folder, name)
            await reload()
            done(null)
            navigate(fileRoute(made.path))
          }}
        />
      )}
      {action.kind === 'new-canvas' && (
        <NameDialog
          title={t('canvas.newTitle', { folder: action.folder.split('/').join(' / ') })}
          hint={t('canvas.newHint')}
          confirm={t('actions.create')}
          initial={t('canvas.untitled')}
          onClose={close}
          onSubmit={async (name) => {
            const made = await canvasApi.create(action.folder, name)
            await reload()
            done(null)
            navigate(fileRoute(made.path))
          }}
        />
      )}
      {action.kind === 'new-folder' && (
        <NameDialog
          title={t('actions.newFolderTitle', { folder: action.parent.split('/').join(' / ') })}
          confirm={t('actions.create')}
          initial=""
          look
          onClose={close}
          onSubmit={async (name, icon, color) => {
            const made = await vaultApi.createFolder(action.parent, name)
            const looked = await lookOf(made.path, icon, color)
            await reload()
            reveal(made.path)
            done(t('actions.folderMade', { name }) + (looked ? '' : ' ' + t('looks.notSaved')))
          }}
        />
      )}
      {action.kind === 'rename' && (
        <NameDialog
          title={t('actions.renameTitle', { name: baseName(action.path) })}
          hint={t(action.path.includes('/') ? 'actions.renameHint' : 'actions.renameSpaceHint')}
          confirm={t('actions.renameDo')}
          initial={action.file ? action.path.slice(action.path.lastIndexOf('/') + 1) : baseName(action.path)}
          onClose={close}
          onSubmit={async (name) => {
            // A space has no folder around it: it is renamed as a whole, and links naming it follow (block Y2).
            const moved = action.path.includes('/')
              ? await moveTo(action.path, `${folderOf(action.path)}/${name}${action.folder || action.file ? '' : '.md'}`)
              : await moveTo(action.path, name, vaultApi.renameSpace)
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

/** The look of a space or folder just made: that stands already, so a failure here is said, not thrown. */
async function lookOf(path: string, icon: string | null, color: string | null): Promise<boolean> {
  if (!icon && !color) return true
  try {
    await looksApi.put(path, icon, color)
    return true
  } catch {
    return false
  }
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

/** A name; for a new space or folder (`look`) also its symbol and colour, chosen right away. */
function NameDialog({ title, hint, confirm, initial, look = false, onClose, onSubmit }: { title: string; hint?: string; confirm: string; initial: string; look?: boolean; onClose: () => void; onSubmit: (name: string, icon: string | null, color: string | null) => Promise<void> }) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial)
  const [icon, setIcon] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const { busy, problem, submit } = useSubmit(() => onSubmit(name.trim(), icon, color))
  const unchanged = !name.trim() || name.trim() === initial
  return (
    <Frame title={title} onClose={onClose} onSubmit={() => !unchanged && void submit()} testId="name-dialog">
      <div className="min-h-0 space-y-2 overflow-y-auto p-4">
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
        {look && (
          <div className="space-y-4 pt-2">
            <LookPicker icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
          </div>
        )}
        {problem && <p role="alert" className="text-sm text-bad-500">{errorText(problem)}</p>}
      </div>
      <Buttons confirm={confirm} busy={busy} disabled={unchanged} onClose={onClose} />
    </Frame>
  )
}

/** The folders of the space; the item itself and what lies in it cannot be the target. */
/** Public pages show this or something in it: said before moving or trashing (they went without a word, P6.19). */
function useShared(path: string): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let live = true
    shareApi.covers(path).then(
      (found) => live && setCount(found.count),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [path])
  return count
}

function MoveDialog({ path, folder, onClose, onMove }: { path: string; folder: boolean; onClose: () => void; onMove: (target: string) => Promise<void> }) {
  const { t } = useTranslation()
  const [target, setTarget] = useState<string | null>(null)
  const { busy, problem, submit } = useSubmit(() => onMove(target!))
  const shared = useShared(path)
  return (
    <Frame title={t('actions.moveTitle', { name: baseName(path) })} onClose={onClose} onSubmit={() => target && void submit()} testId="move-dialog">
      <div className="min-h-0 space-y-2 overflow-y-auto p-4">
        <p className="text-xs text-mist-500">{t('actions.moveHint')}</p>
        {shared > 0 && <p className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500" data-testid="shared-warning">{t('actions.sharedMove', { count: shared })}</p>}
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

/** A symbol and a colour for a space or folder; "none" and "automatic" give it back to nexlore. */
function LookDialog({ path, onClose, onSave }: { path: string; onClose: () => void; onSave: (icon: string | null, color: string | null) => Promise<void> }) {
  const { t } = useTranslation()
  const { looks } = useStore()
  const [space, ...rest] = path.split('/')
  const now = looks[space]?.[rest.join('/')]
  const [icon, setIcon] = useState<string | null>(now?.icon ?? null)
  const [color, setColor] = useState<string | null>(now?.color ?? null)
  const { busy, problem, submit } = useSubmit(() => onSave(icon, color))
  return (
    <Frame title={t('looks.title', { name: rest.length ? rest[rest.length - 1] : space })} onClose={onClose} onSubmit={() => void submit()} testId="look-dialog">
      <div className="min-h-0 space-y-4 overflow-y-auto p-4">
        <LookPicker icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
        <p className="text-xs text-mist-500">{t('looks.hint')}</p>
        {problem && <p role="alert" className="text-sm text-bad-500">{errorText(problem)}</p>}
      </div>
      <Buttons confirm={t('common.save')} busy={busy} onClose={onClose} />
    </Frame>
  )
}

/** The symbols (own ones, Lucide by search) and the colours: where a space or folder is made, and where it changes. */
function LookPicker({ icon, color, onIcon, onColor }: { icon: string | null; color: string | null; onIcon: (icon: string | null) => void; onColor: (color: string | null) => void }) {
  const { t } = useTranslation()
  const { choices } = useStore()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const lucide = useLucide()
  const found = useMemo(() => {
    if (!lucide) return []
    if (query.trim()) return searchLucide(lucide, query)
    return all ? Object.keys(lucide).map((name) => 'l:' + name) : []
  }, [lucide, query, all])
  const choice = (selected: boolean) =>
    'grid h-9 w-9 place-items-center rounded-lg border ' + (selected ? 'border-accent-500 bg-accent-500/15' : 'border-ink-700 hover:bg-ink-850')
  return (
    <>
        <fieldset>
          <legend className="mb-2 text-xs text-mist-500">{t('looks.symbol')}</legend>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={icon === null} onClick={() => onIcon(null)} className={choice(icon === null) + ' w-auto px-2.5 text-xs text-mist-400'}>
              {t('looks.noSymbol')}
            </button>
            {choices.icons.map((name) => (
              <button key={name} type="button" aria-pressed={icon === name} aria-label={t(`looks.icons.${name}`)} title={t(`looks.icons.${name}`)} onClick={() => onIcon(name)} className={choice(icon === name)}>
                <span style={{ color: color ?? undefined }}>
                  <Symbol name={name as SymbolName} className="h-4.5 w-4.5" />
                </span>
              </button>
            ))}
            {/* A Lucide symbol chosen earlier stays in sight among the own ones. */}
            {icon && isLucide(icon) && !found.includes(icon) && (
              <button type="button" aria-pressed aria-label={icon.slice(2).replace(/-/g, ' ')} title={icon.slice(2)} className={choice(true)}>
                <span style={{ color: color ?? undefined }}>
                  <LookIcon name={icon} className="h-4.5 w-4.5" />
                </span>
              </button>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('looks.search', { count: lucide ? Object.keys(lucide).length : 1800 })}
              aria-label={t('looks.searchLabel')}
              className="h-9 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 text-sm text-mist-100 outline-none focus:border-accent-500"
            />
            {!query.trim() && (
              <button type="button" onClick={() => setAll((value) => !value)} className="shrink-0 rounded-full border border-ink-700 px-3 py-1 text-xs text-mist-300 hover:bg-ink-850">
                {all ? t('looks.fewer') : t('looks.all')}
              </button>
            )}
          </div>
          {query.trim() && lucide && found.length === 0 && <p className="mt-2 text-xs text-mist-500">{t('looks.none')}</p>}
          {found.length > 0 && (
            <div className="nn-scroll mt-2 flex max-h-56 flex-wrap gap-1.5 overflow-y-auto" data-testid="look-found">
              {found.map((name) => (
                <button key={name} type="button" aria-pressed={icon === name} aria-label={name.slice(2).replace(/-/g, ' ')} title={name.slice(2)} onClick={() => onIcon(name)} className={choice(icon === name)}>
                  <span style={{ color: color ?? undefined }}>
                    <LookIcon name={name} className="h-4.5 w-4.5" />
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-mist-600">{t('looks.lucide')}</p>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs text-mist-500">{t('looks.color')}</legend>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={color === null} onClick={() => onColor(null)} className={choice(color === null) + ' w-auto px-2.5 text-xs text-mist-400'}>
              {t('looks.automatic')}
            </button>
            {choices.colors.map((value, index) => (
              <button key={value} type="button" aria-pressed={color === value} aria-label={t(`looks.colors.${index}`)} title={t(`looks.colors.${index}`)} onClick={() => onColor(value)} className={choice(color === value)}>
                <span className="h-4 w-4 rounded-full" style={{ background: value }} />
              </button>
            ))}
          </div>
        </fieldset>
    </>
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
      <TrashWarnings path={path} folder={folder} />
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
