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
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import '@milkdown/crepe/theme/common/style.css'
import '../styles/editor.css'

import { createEditor, type EditorLabels, type NoteEditor as Engine } from '../editor/editor'
import { splitNote } from '../editor/frontmatter'
import type { LinkHelpers } from '../editor/live'
import { searchNames } from '../editor/suggest'
import { linkIndex } from '../lib/links'
import type { Vault } from '../lib/vault'
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
  vault: Vault
  mode: EditorMode
  readOnly?: boolean
  onChange: () => void
  onLeave: (text: string) => void
  onOpenLink: (target: string, newTab: boolean) => void
  onFileRefused?: () => void
}

export const NoteEditor = forwardRef<EditorHandle, Props>(function NoteEditor(
  { path, content, vault, mode, readOnly = false, onChange, onLeave, onOpenLink, onFileRefused },
  ref,
) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<Engine | null>(null)
  // The note as last shown or typed: head and body kept apart; `body` is only current while no editor runs.
  const initial = useMemo(() => splitNote(content), [content])
  const [head, setHead] = useState(initial.head)
  const headRef = useRef(initial.head)
  const body = useRef(initial.body)
  const [source, setSource] = useState('')
  const sourceRef = useRef('')
  const [problem, setProblem] = useState<string | null>(null)

  const latest = useRef({ onChange, onLeave, onOpenLink, onFileRefused })
  latest.current = { onChange, onLeave, onOpenLink, onFileRefused }
  const links = useMemo(() => linkIndex(vault, path), [vault, path])
  const linksRef = useRef(links)
  linksRef.current = links
  useEffect(() => engine.current?.refresh(), [links])

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
    const helpers: LinkHelpers = {
      exists: (target) => linksRef.current.exists(target),
      open: (target, newTab) => latest.current.onOpenLink(target, newTab),
    }
    const started = body.current
    createEditor({
      root,
      original: started,
      readOnly,
      labels,
      links: () => helpers,
      search: () => (query) => searchNames(linksRef.current.suggestions, query),
      onChange: () => latest.current.onChange(),
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
        <div ref={host} className="nx-editor-host" />
      )}
    </div>
  )
})

function editorLabels(t: (key: string) => string): EditorLabels {
  const s = (key: string) => t(`editor.slash.${key}`)
  return {
    placeholder: t('note.editorPlaceholder'),
    suggestions: t('editor.suggestions'),
    slash: {
      text: s('text'), h1: s('h1'), h2: s('h2'), h3: s('h3'), quote: s('quote'), divider: s('divider'),
      bulletList: s('bulletList'), orderedList: s('orderedList'), taskList: s('taskList'), code: s('code'),
      table: s('table'), math: s('math'), groupText: s('groupText'), groupList: s('groupList'),
      groupAdvanced: s('groupAdvanced'), groupObsidian: s('groupObsidian'), callout: s('callout'),
      wikiLink: s('wikiLink'), embed: s('embed'),
    },
  }
}
