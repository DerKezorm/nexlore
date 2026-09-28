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
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
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
import { useContextMenu, type MenuItem } from '../lib/menu'
import { baseName } from '../lib/vault'
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
  onFileRefused?: () => void
  /** Files were uploaded (what came out of them is in each). */
  onUploaded?: (done: Uploaded[]) => void
  /** An upload was refused; the server's code says why. */
  onUploadFailed?: (code: string) => void
}

export const NoteEditor = forwardRef<EditorHandle, Props>(function NoteEditor(
  { path, content, links, mode, readOnly = false, onChange, onLeave, onOpenLink, onFileRefused, onUploaded, onUploadFailed },
  ref,
) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<Engine | null>(null)
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
        // The note was loaded again while the editor was starting.
        if (body.current !== started) editor.replace(body.current)
        if (!readOnly) editor.view.focus()
      })
      .catch(() => setProblem('editor_failed'))
    return () => {
      alive = false
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
    const items: MenuItem[] = [
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

  if (problem) return <p className="text-sm text-bad-500">{t('note.editorFailed')}</p>

  return (
    <div className="nx-note-editor">
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
          className="nx-source min-h-[60vh] w-full resize-y rounded-xl border border-ink-700 bg-ink-900 p-4 font-mono text-[13px] leading-6 text-mist-200 outline-none focus:border-accent-500"
        />
      ) : (
        <div ref={host} className="nx-editor-host" onContextMenu={openMenu} />
      )}
      {menu.element}
    </div>
  )
})

function editorLabels(t: (key: string) => string): EditorLabels {
  const s = (key: string) => t(`editor.slash.${key}`)
  return {
    placeholder: t('note.editorPlaceholder'),
    suggestions: t('editor.suggestions'),
    link: t('editor.link'),
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
