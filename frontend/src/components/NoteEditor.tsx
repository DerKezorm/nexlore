/**
 * The editor of a note: the properties (front matter) on top, the text below in Milkdown Crepe with the Obsidian
 * layer, and a plain Markdown view for those who want it (menu of the note page).
 *
 * The page asks for the text to save with `text()`: the head (untouched unless a property changed) plus the body
 * through the block layer, so only what was changed differs from the file. The editor itself only says that
 * something changed (`onChange`), serializing nothing while typing.
 *
 * When the editor goes away (another note, back to reading), it hands its last text to `onLeave` first: layout
 * effects are cleaned up before the page's own effects, so the page's last save has the words typed just before.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { TextSelection } from '@milkdown/kit/prose/state'
import { useTranslation } from 'react-i18next'

import '@milkdown/crepe/theme/common/style.css'
import '../styles/editor.css'

import { ApiError, fileUrl, uploadFile, vaultApi, type Uploaded } from '../api/client'
import { createEditor, type EditorCommand, type EditorLabels, type FileHelpers, type NoteEditor as Engine } from '../editor/editor'
import { splitNote } from '../editor/frontmatter'
import type { LinkHelpers } from '../editor/live'
import { fileKind, isFileTarget, isPasted, relativeTarget } from '../lib/files'
import type { LinkIndex } from '../lib/links'
import { aiMenu, type AiAsk } from '../lib/aiMenu'
import { useContextMenu, type MenuItem } from '../lib/menu'
import { linesShown, rememberLines, rememberToolbar, toolbarHidden } from '../lib/toolbar'
import { baseName } from '../lib/vault'
import { useCommands, type Command } from '../lib/commands'
import { useAuth } from '../state/auth'
import { CONTEXT, type Anchor } from '../lib/comments'
import { Symbol } from './Symbol'
import { AiDialog } from './AiDialog'
import { EditorToolbar, ShowToolbar } from './EditorToolbar'
import { FindBar } from './FindBar'
import { Properties } from './Properties'

export type EditorMode = 'visual' | 'source'

export type EditorHandle = {
  /** The whole note as it would be saved now. */
  text: () => string
  /** The note changed on disk and nothing was typed here: show the new text. */
  replace: (content: string) => void
}

type Props = {
  path: string
  /** The note as it is on disk. Read once; later changes come through `replace`. */
  content: string
  /** Where the note's wiki links lead, asked from the server (made and seeded by the page). */
  links: LinkIndex
  mode: EditorMode
  readOnly?: boolean
  onChange: () => void
  onLeave: (text: string) => void
  onOpenLink: (target: string, newTab: boolean) => void
  /** The toolbar's way to the plain Markdown view. */
  onSource?: () => void
  /** A line for the page's notice (an AI result taken over, a note made from it). */
  onNotice?: (text: string) => void
  onFileRefused?: () => void
  /** Files were uploaded (what came out of them is in each). */
  onUploaded?: (done: Uploaded[]) => void
  /** An upload was refused; the server's code says why. */
  onUploadFailed?: (code: string) => void
  /** Words chosen in the text get a comment (the page opens the column with a new thread). */
  onComment?: (anchor: Anchor) => void
}

export const NoteEditor = forwardRef<EditorHandle, Props>(function NoteEditor(
  { path, content, links, mode, readOnly = false, onChange, onLeave, onOpenLink, onSource, onNotice, onFileRefused, onUploaded, onUploadFailed, onComment },
  ref,
) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<Engine | null>(null)
  // The same editor for the toolbar, which draws again when it comes.
  const [ready, setReady] = useState<Engine | null>(null)
  const [toolbarOff, setToolbarOff] = useState(toolbarHidden)
  const [lines, setLines] = useState(linesShown)
  // AI in the editor: only when the operator allows it and the account switched its own service on.
  const { me } = useAuth()
  const aiReady = !!me?.ai_ready && !readOnly
  const [aiAsk, setAiAsk] = useState<AiAsk | null>(null)
  // Files that wiki links name, as the server resolves them: vault path, or null when there is none.
  const fileTargets = useRef(new Map<string, string | null>())
  // The note as last shown or typed: head and body kept apart; `body` is only current while no editor runs.
  const initial = useMemo(() => splitNote(content), [content])
  const [head, setHead] = useState(initial.head)
  const headRef = useRef(initial.head)
  const body = useRef(initial.body)
  const [source, setSource] = useState('')
  const sourceRef = useRef('')
  const [problem, setProblem] = useState<string | null>(null)
  const menu = useContextMenu()
  // Find and replace: open or not, the row for replacing, and each ask to focus a field (Ctrl+F, Ctrl+H).
  const [finding, setFinding] = useState<{ field: 'find' | 'replace'; seed: string | null; ask: number } | null>(null)
  const [replacing, setReplacing] = useState(false)

  const latest = useRef({ onChange, onLeave, onOpenLink, onFileRefused, onUploaded, onUploadFailed })
  latest.current = { onChange, onLeave, onOpenLink, onFileRefused, onUploaded, onUploadFailed }
  const linksRef = useRef(links)
  linksRef.current = links
  useEffect(() => {
    links.listen(() => engine.current?.refresh())
    engine.current?.refresh()
  }, [links])

  const modeRef = useRef(mode)
  modeRef.current = mode
  const current = (): string => {
    if (modeRef.current === 'source') return sourceRef.current
    return headRef.current + (engine.current ? engine.current.text() : body.current)
  }

  useImperativeHandle(ref, () => ({
    text: current,
    replace: (next: string) => {
      const split = splitNote(next)
      headRef.current = split.head
      setHead(split.head)
      body.current = split.body
      if (modeRef.current === 'source') {
        sourceRef.current = next
        setSource(next)
      } else engine.current?.replace(split.body)
    },
  }))

  // The visual editor: made when the mode is visual, its text kept when it goes.
  useEffect(() => {
    if (mode !== 'visual' || !host.current) return
    const root = document.createElement('div')
    host.current.appendChild(root)
    let alive = true
    let made: Engine | null = null
    const labels = editorLabels(t)
    // A file target the server has not been asked about yet: asked once, and the links are drawn again with the answer.
    const lookup = (target: string): string | null | undefined => {
      const key = target.split('#')[0].split('|')[0].trim()
      if (fileTargets.current.has(key)) return fileTargets.current.get(key)
      fileTargets.current.set(key, undefined as never)
      vaultApi
        .resolve(path, key, 'embed')
        .then((found) => found.path, () => null)
        .then((found) => {
          fileTargets.current.set(key, found)
          if (alive) engine.current?.refresh()
        })
      return undefined
    }
    // A note of that name wins: `[[Report.pdf]]` is the note when there is one called so.
    const asFile = (target: string) => isFileTarget(target) && !linksRef.current.resolve(target)
    const helpers: LinkHelpers = {
      exists: (target) => (asFile(target) ? lookup(target) !== null : linksRef.current.exists(target)),
      open: (target, newTab) => latest.current.onOpenLink(target, newTab),
      embed: (target) => {
        if (!asFile(target)) return null
        const found = lookup(target)
        if (found === null || found === undefined) return found
        const kind = fileKind(found)
        return kind === 'image' || kind === 'video' || kind === 'audio' ? { url: fileUrl(found), kind } : null
      },
    }
    const files: FileHelpers = {
      src: (written) => {
        const target = relativeTarget(path, written)
        return target ? fileUrl(target) : written
      },
      upload: async (chosen) => {
        const results = await Promise.all(
          chosen.map((file) =>
            uploadFile(file, { note: path, pasted: isPasted(file) }).catch((error: unknown) => {
              latest.current.onUploadFailed?.(error instanceof ApiError ? error.code : 'internal_error')
              return null
            }),
          ),
        )
        const done = results.filter((item): item is Uploaded => item !== null)
        if (done.length) {
          // A link typed before its file was there was looked up as missing: asked again now.
          for (const [key, found] of fileTargets.current) if (found === null) fileTargets.current.delete(key)
          engine.current?.refresh()
          latest.current.onUploaded?.(done)
        }
        return results.map((item) => item && { link: item.link, name: baseName(item.path), image: fileKind(item.path) === 'image' })
      },
    }
    const started = body.current
    createEditor({
      root,
      original: started,
      readOnly,
      labels,
      links: () => helpers,
      search: () => (query) => linksRef.current.search(query),
      onChange: () => latest.current.onChange(),
      files: readOnly ? undefined : files,
      onFileRefused: () => latest.current.onFileRefused?.(),
    })
      .then((editor) => {
        if (!alive) return void editor.destroy()
        made = editor
        engine.current = editor
        setReady(editor)
        // The note was loaded again while the editor was starting.
        if (body.current !== started) editor.replace(body.current)
        if (!readOnly) editor.view.focus()
      })
      .catch(() => setProblem('editor_failed'))
    return () => {
      alive = false
      setReady(null)
      if (made) {
        body.current = made.text()
        if (engine.current === made) engine.current = null
        const gone = made
        void gone.destroy().finally(() => root.remove())
      } else root.remove()
    }
    // Made once per mode; the page gives the editor a new key for another note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, readOnly])

  // Switching to the Markdown view: the whole note as text.
  useEffect(() => {
    if (mode !== 'source') return
    const text = headRef.current + body.current
    sourceRef.current = text
    setSource(text)
    return () => {
      const split = splitNote(sourceRef.current)
      headRef.current = split.head
      setHead(split.head)
      body.current = split.body
    }
  }, [mode])

  // Before the page's effects run their clean-up: the last text goes to the page.
  useLayoutEffect(() => {
    return () => latest.current.onLeave(current())
  }, [])

  /**
   * The words chosen in the text as the anchor of a comment: they and a little around them, as plain text, the way
   * the reading view shows them (where the thread's words are found and lit again).
   */
  const commentAnchor = (): Anchor | null => {
    const now = engine.current
    if (!now) return null
    const { doc, selection } = now.view.state
    const { from, to, empty } = selection
    if (empty) return null
    const chosen = doc.textBetween(from, to, '\n')
    const quote = chosen.trim()
    if (!quote) return null
    const lead = chosen.length - chosen.trimStart().length
    const tail = chosen.length - chosen.trimEnd().length
    return {
      quote,
      before: (doc.textBetween(Math.max(0, from - CONTEXT * 2), from, '\n') + chosen.slice(0, lead)).slice(-CONTEXT),
      after: (chosen.slice(chosen.length - tail) + doc.textBetween(to, Math.min(doc.content.size, to + CONTEXT * 2), '\n')).slice(0, CONTEXT),
    }
  }
  const comment = () => {
    const anchor = commentAnchor()
    if (anchor) onComment?.(anchor)
  }
  // Words chosen while writing: the "Comment" button beside their end, as in the reading view.
  const [commentAt, setCommentAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!ready || !onComment) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const { selection } = ready.view.state
        if (selection.empty || !ready.view.hasFocus() || !ready.view.state.doc.textBetween(selection.from, selection.to, ' ').trim()) return setCommentAt(null)
        const end = ready.view.coordsAtPos(selection.to)
        setCommentAt({ x: Math.min(end.left, window.innerWidth - 140), y: end.bottom + 6 })
      })
    }
    const stop = ready.subscribe(update)
    const blur = () => setCommentAt(null)
    ready.view.dom.addEventListener('blur', blur)
    return () => {
      stop()
      cancelAnimationFrame(frame)
      ready.view.dom.removeEventListener('blur', blur)
    }
  }, [ready, onComment])

  /** Ctrl+F and Ctrl+H: the bar opens, the words chosen in one line of the text in its field. */
  const askFind = (replace: boolean) => {
    const now = engine.current
    if (!now) return
    const { from, to, empty } = now.view.state.selection
    const chosen = empty ? '' : now.view.state.doc.textBetween(from, to, '\n')
    const seed = chosen && !chosen.includes('\n') ? chosen : null
    if (replace) setReplacing(true)
    setFinding((was) => ({ field: replace && (seed ?? was) ? 'replace' : 'find', seed, ask: (was?.ask ?? 0) + 1 }))
  }
  const findKeys = (event: KeyboardEvent) => {
    if (event.defaultPrevented || mode !== 'visual' || readOnly || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    const key = event.key.toLowerCase()
    if (key !== 'f' && key !== 'h') return
    event.preventDefault()
    askFind(key === 'h')
  }
  // Closed with the editor: another mode, another note.
  useEffect(() => {
    if (!ready) setFinding(null)
  }, [ready])
  // F3 in the text while the bar is open.
  const stepKeys = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !finding || event.key !== 'F3' || !engine.current) return
    event.preventDefault()
    if (event.shiftKey) engine.current.find.previous()
    else engine.current.find.next()
  }

  /**
   * The editor's own menu for the right mouse button: clipboard, format, paragraph, insert; on a wiki link its note
   * first. A long press on a touch screen keeps the phone's own menu (selecting text needs it).
   */
  const openMenu = (event: MouseEvent) => {
    const engineNow = engine.current
    if (!engineNow || readOnly || (event.nativeEvent as PointerEvent).pointerType === 'touch') return
    event.preventDefault()
    // A click outside the selection puts the caret where it was: the menu works on what was clicked.
    const { view } = engineNow
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
    const { from, to } = view.state.selection
    if (at !== undefined && (at < from || at > to)) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))))
    const run = (command: EditorCommand) => () => engineNow.run(command)
    const clip = (what: 'cut' | 'copy') => () => {
      engineNow.view.focus()
      document.execCommand(what)
    }
    const s = (key: string) => t(`editor.slash.${key}`)
    const target = (event.target as Element).closest('.nx-wiki[data-target]')?.getAttribute('data-target')
    // Reading the clipboard needs a secure page (https); on plain http the keyboard still pastes.
    const canPaste = window.isSecureContext && !!navigator.clipboard?.readText
    const commentable = !!onComment && !!commentAnchor()
    const items: MenuItem[] = [
      ...(commentable ? ([{ label: t('comments.here'), symbol: 'pencil', onSelect: comment }, 'separator'] satisfies MenuItem[]) : []),
      ...(target
        ? ([
            { label: t('editorMenu.openLink'), symbol: 'note', onSelect: () => latest.current.onOpenLink(target, false) },
            { label: t('editorMenu.openLinkNewTab'), symbol: 'open', onSelect: () => latest.current.onOpenLink(target, true) },
            'separator',
          ] satisfies MenuItem[])
        : []),
      { label: t('editorMenu.cut'), symbol: 'cut', hint: t('editorMenu.keyCut'), onSelect: clip('cut') },
      { label: t('editorMenu.copy'), symbol: 'copy', hint: t('editorMenu.keyCopy'), onSelect: clip('copy') },
      {
        label: t('editorMenu.paste'),
        symbol: 'paste',
        hint: t('editorMenu.keyPaste'),
        disabled: !canPaste,
        onSelect: () => {
          void navigator.clipboard.readText().then((text) => {
            engineNow.view.focus()
            engineNow.view.dispatch(engineNow.view.state.tr.insertText(text).scrollIntoView())
          })
        },
      },
      'separator',
      {
        label: t('editorMenu.format'),
        items: [
          { label: t('editorMenu.bold'), hint: t('editorMenu.keyBold'), onSelect: run('bold') },
          { label: t('editorMenu.italic'), hint: t('editorMenu.keyItalic'), onSelect: run('italic') },
          { label: t('editorMenu.strike'), onSelect: run('strike') },
          { label: t('editorMenu.code'), onSelect: run('code') },
          { label: t('editorMenu.highlight'), onSelect: run('highlight') },
        ],
      },
      {
        label: t('editorMenu.paragraph'),
        items: [
          { label: s('text'), onSelect: run('text') },
          { label: s('h1'), onSelect: run('h1') },
          { label: s('h2'), onSelect: run('h2') },
          { label: s('h3'), onSelect: run('h3') },
          { label: s('quote'), onSelect: run('quote') },
          { label: s('bulletList'), onSelect: run('bulletList') },
          { label: s('orderedList'), onSelect: run('orderedList') },
          { label: s('taskList'), onSelect: run('taskList') },
          { label: s('code'), onSelect: run('codeBlock') },
        ],
      },
      ...(aiReady ? ([{ label: t('ai.menu'), symbol: 'sparkle', items: aiMenu(t, setAiAsk) }] satisfies MenuItem[]) : []),
      {
        label: t('editorMenu.insert'),
        items: [
          { label: s('wikiLink'), symbol: 'link', onSelect: run('wikiLink') },
          { label: s('callout'), onSelect: run('callout') },
          { label: s('table'), onSelect: run('table') },
          { label: s('divider'), onSelect: run('divider') },
          { label: s('attachment'), symbol: 'clip', onSelect: run('attachment') },
        ],
      },
      'separator',
      { label: t('editorMenu.selectAll'), hint: t('editorMenu.keySelectAll'), onSelect: run('selectAll') },
    ]
    menu.open(event.clientX, event.clientY, items)
  }

  // The palette's formats and blocks, while the visual editor is open for writing.
  useCommands((): Command[] => {
    // Offered from the first moment; a command asks for the editor only when it runs (it loads a little later).
    if (readOnly || mode !== 'visual') return []
    const group = t('palette.editor')
    const s = (key: string) => t(`editor.slash.${key}`)
    const run = (command: EditorCommand) => () => {
      const now = engine.current
      if (!now) return
      now.view.focus()
      now.run(command)
    }
    const entry = (command: EditorCommand, label: string, symbol?: Command['symbol'], keys?: string): Command => ({ id: 'editor.' + command, label, group, symbol, keys, run: run(command) })
    return [
      { id: 'editor.find', label: t('find.command'), group, symbol: 'search', keys: t('find.keyFind'), run: () => askFind(false) },
      { id: 'editor.replace', label: t('find.commandReplace'), group, symbol: 'search', keys: t('find.keyReplace'), run: () => askFind(true) },
      entry('bold', t('editorMenu.bold'), 'bold', t('editorMenu.keyBold')),
      entry('italic', t('editorMenu.italic'), 'italic', t('editorMenu.keyItalic')),
      entry('strike', t('editorMenu.strike'), 'strike'),
      entry('highlight', t('editorMenu.highlight'), 'highlight'),
      entry('code', t('editorMenu.code'), 'code'),
      entry('clear', t('toolbar.clear'), 'clearFormat'),
      entry('text', s('text')),
      entry('h1', s('h1'), 'heading'),
      entry('h2', s('h2'), 'heading'),
      entry('h3', s('h3'), 'heading'),
      entry('quote', s('quote'), 'quote'),
      entry('bulletList', s('bulletList'), 'listBullet'),
      entry('orderedList', s('orderedList'), 'listOrdered'),
      entry('taskList', s('taskList'), 'listTask'),
      entry('codeBlock', s('code'), 'codeBlock'),
      entry('wikiLink', s('wikiLink'), 'link'),
      entry('embed', s('embed'), 'embed'),
      entry('callout', s('callout'), 'info'),
      entry('table', s('table'), 'table'),
      entry('math', s('math'), 'sigma'),
      entry('divider', s('divider')),
      entry('attachment', s('attachment'), 'clip'),
      entry('undo', t('toolbar.undo'), 'undo'),
      entry('redo', t('toolbar.redo'), 'redo'),
    ]
  })

  // The file's line numbers: the body starts on the line after the front matter (its lines end with a line break).
  useEffect(() => {
    ready?.lineNumbers(lines ? head.split('\n').length : null)
  }, [ready, lines, head])

  if (problem) return <p className="text-sm text-bad-500">{t('note.editorFailed')}</p>

  const toolbar = mode === 'visual' && !readOnly
  const findBar =
    toolbar && finding && ready ? (
      <FindBar
        key={path}
        editor={ready}
        focus={finding}
        replacing={replacing}
        onReplacing={setReplacing}
        onClose={() => setFinding(null)}
      />
    ) : null
  return (
    <div
      className={'nx-note-editor' + (toolbar && !toolbarOff ? ' pb-14 sm:pb-0' : '')}
      data-lines={lines ? 'on' : undefined}
      onKeyDown={(event) => {
        findKeys(event)
        stepKeys(event)
      }}
    >
      {toolbar &&
        (toolbarOff ? (
          <>
            <ShowToolbar
              onShow={() => {
                rememberToolbar(false)
                setToolbarOff(false)
                engine.current?.view.focus()
              }}
            />
            {findBar && <div className="sticky top-0 z-20 -mx-1 mb-3 rounded-xl border border-ink-700 bg-ink-900/95 px-1.5 backdrop-blur">{findBar}</div>}
          </>
        ) : (
          <EditorToolbar
            editor={ready}
            findBar={findBar}
            onFind={() => askFind(false)}
            ai={aiReady ? () => aiMenu(t, setAiAsk) : undefined}
            onSource={() => onSource?.()}
            onHide={() => {
              rememberToolbar(true)
              setToolbarOff(true)
            }}
            lines={lines}
            onLines={() => {
              rememberLines(!lines)
              setLines(!lines)
            }}
            openMenu={menu.open}
          />
        ))}
      {mode === 'visual' && (
        <Properties
          key={head === '' ? 'none' : 'head'}
          head={head}
          readOnly={readOnly}
          onChange={(next) => {
            headRef.current = next
            setHead(next)
            latest.current.onChange()
          }}
        />
      )}
      {mode === 'source' ? (
        <SourceLines lines={lines} text={source}>
        <textarea
          value={source}
          readOnly={readOnly}
          spellCheck={false}
          aria-label={t('note.sourceLabel')}
          onChange={(event) => {
            sourceRef.current = event.target.value
            setSource(event.target.value)
            latest.current.onChange()
          }}
          wrap={lines ? 'off' : undefined}
          className={
            'nx-source min-h-[60vh] w-full resize-y rounded-xl border border-ink-700 bg-ink-900 p-4 font-mono text-[13px] leading-6 text-mist-200 outline-none focus:border-accent-500' +
            (lines ? ' pl-14' : '')
          }
        />
        </SourceLines>
      ) : (
        <div ref={host} className="nx-editor-host" onContextMenu={openMenu} />
      )}
      {menu.element}
      {commentAt && (
        <button
          type="button"
          data-testid="comment-here"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            comment()
            setCommentAt(null)
          }}
          style={{ left: commentAt.x, top: commentAt.y }}
          className="fixed z-30 inline-flex items-center gap-1.5 rounded-full border border-accent-500/60 bg-ink-900 px-3 py-1 text-xs font-semibold text-accent-300 shadow-lg hover:bg-ink-850"
        >
          <Symbol name="pencil" className="h-3.5 w-3.5" />
          {t('comments.here')}
        </button>
      )}
      {aiAsk && ready && (
        <AiDialog engine={ready} ask={aiAsk} notePath={path} onClose={() => setAiAsk(null)} onNotice={(text) => onNotice?.(text)} />
      )}
    </div>
  )
})

/** The file's line numbers beside the Markdown view: a column that scrolls with the text, which then does not wrap. */
function SourceLines({ lines, text, children }: { lines: boolean; text: string; children: ReactNode }) {
  const column = useRef<HTMLDivElement>(null)
  if (!lines) return <>{children}</>
  const numbers = Array.from({ length: text.split('\n').length }, (_, index) => index + 1).join('\n')
  return (
    <div
      className="relative"
      onScrollCapture={(event) => {
        if (column.current) column.current.style.transform = `translateY(${-(event.target as HTMLElement).scrollTop}px)`
      }}
    >
      {children}
      <div aria-hidden="true" className="pointer-events-none absolute top-px bottom-px left-px w-11 overflow-hidden rounded-l-xl" data-testid="source-lines">
        <div ref={column} className="pt-4 pr-2 text-right font-mono text-[11px] leading-6 whitespace-pre text-mist-600">
          {numbers}
        </div>
      </div>
    </div>
  )
}

function editorLabels(t: (key: string) => string): EditorLabels {
  const s = (key: string) => t(`editor.slash.${key}`)
  return {
    placeholder: t('note.editorPlaceholder'),
    suggestions: t('editor.suggestions'),
    link: t('editor.link'),
    linkText: t('editor.linkText'),
    handle: { add: t('editor.handleAdd'), drag: t('editor.handleDrag') },
    code: {
      search: t('editor.code.search'), copy: t('editor.code.copy'), noResult: t('editor.code.noResult'),
      edit: t('editor.code.edit'), hide: t('editor.code.hide'), preview: t('editor.code.preview'),
      loading: t('common.loading'),
    },
    slash: {
      text: s('text'), h1: s('h1'), h2: s('h2'), h3: s('h3'), quote: s('quote'), divider: s('divider'),
      bulletList: s('bulletList'), orderedList: s('orderedList'), taskList: s('taskList'), code: s('code'),
      table: s('table'), math: s('math'), groupText: s('groupText'), groupList: s('groupList'),
      groupAdvanced: s('groupAdvanced'), groupObsidian: s('groupObsidian'), callout: s('callout'),
      wikiLink: s('wikiLink'), embed: s('embed'), attachment: s('attachment'),
    },
  }
}
