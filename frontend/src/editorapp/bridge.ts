/**
 * The bridge between nexlore's editor and the iPhone app (nexlore-ios, docs/editor-bruecke.md). The app calls the
 * functions of `Bridge` (main.ts puts them on `window.nexloreEditor`); the editor tells the app what happens through
 * `post`, which main.ts points at `webkit.messageHandlers.nexlore`. Every call returns at once: its work is queued and
 * done in the order the calls came.
 *
 * The editor is the note page's own: the front matter as properties on top, the body in Milkdown with the block
 * layer, so only what was changed differs from the file. It knows no server. Suggestions after `[[` and `#`, and the
 * files a note shows, are asked of the app (`suggest`, `asset`), which answers with `answer(id, payload)`. Nothing is
 * saved here: `change` hands the whole note to the app, at most every 300 ms.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { setBlockType } from '@milkdown/kit/prose/commands'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

import i18n from '../i18n'
import { Properties } from '../components/Properties'
import { createEditor, type EditorCommand, type NoteEditor } from '../editor/editor'
import { splitNote } from '../editor/frontmatter'
import { editorLabels } from '../editor/labels'
import type { EmbedShown, LinkHelpers } from '../editor/live'
import { linkSuggest, refreshSuggest, type Active, type Suggestion } from '../editor/suggest'
import { fileKind, isFileTarget } from '../lib/files'
import { rebase } from './rebase'

export type Theme = { mode: 'dark' | 'light'; accent?: string }

export type LoadOptions = {
  text: string
  readOnly?: boolean
  theme?: Theme
  fontSize?: number
  spellcheck?: boolean
  placeholder?: string
}

/** What the keys above the keyboard light. */
export type KeyState = { bold: boolean; italic: boolean; heading: number; list: boolean; task: boolean; canUndo: boolean; canRedo: boolean }

export type Message =
  | { type: 'ready'; version: string }
  | { type: 'change'; text: string }
  | ({ type: 'state' } & KeyState)
  | { type: 'openLink'; target: string; kind: 'wiki' | 'url' | 'tag' }
  | { type: 'suggest'; id: string; kind: 'wiki' | 'tag'; query: string }
  | { type: 'asset'; id: string; path: string }
  | { type: 'height'; px: number }
  | { type: 'error'; message: string }

export type Bridge = {
  load: (options: LoadOptions) => void
  setText: (text: string) => void
  setTheme: (theme: Theme) => void
  setReadOnly: (readOnly: boolean) => void
  command: (name: string, args?: Record<string, unknown>) => void
  answer: (id: string | number, payload: unknown) => void
  focus: () => void
  blur: () => void
}

/** `change` comes at most this often; what is typed in between goes with the next one. */
export const CHANGE_EVERY = 300

/** A tag being typed: `#` at the start or after a blank, then what a tag may hold so far (as live.ts draws tags). */
const TAG_OPEN = /(?<![^\s])#([\p{L}\p{N}_/-]*)$/u
const tagKey = new PluginKey<Active>('nxTagSuggest')

/** The bridge's names for the keys above the keyboard that are the note page's commands as they are. */
const COMMANDS: Record<string, EditorCommand> = {
  bold: 'bold', italic: 'italic', strike: 'strike', code: 'code', link: 'link', wikilink: 'wikiLink',
  bullet: 'bulletList', ordered: 'orderedList', task: 'taskList', quote: 'quote',
  indent: 'indent', outdent: 'outdent', undo: 'undo', redo: 'redo',
}

/**
 * The file a picture's address names, as the note writes it: `Anh%C3%A4nge/Foto%201.png` is `Anhänge/Foto 1.png`.
 * Null for an address elsewhere (`https:`, `data:`): that one is shown as it is.
 */
export function assetPath(written: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(written) || written.startsWith('//')) return null
  let path = written.replace(/[?#].*$/, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    // Not encoded after all: taken as written.
  }
  return path || null
}

/** An answer to `suggest`: what the list can show, nothing else. The `#` or brackets around it are already typed. */
function suggestionList(payload: unknown, kind: 'wiki' | 'tag'): Suggestion[] {
  if (!Array.isArray(payload)) return []
  return payload
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof item.label === 'string')
    .map((item) => {
      const insert = typeof item.insert === 'string' ? item.insert : (item.label as string)
      return {
        label: item.label as string,
        insert: kind === 'tag' ? insert.replace(/^#+/, '') : insert.replace(/^\[\[(.*)\]\]$/s, '$1'),
        detail: typeof item.detail === 'string' ? item.detail : '',
      }
    })
}

/** An answer to `asset`: its address, or '' for none (a script address never becomes the source of a frame). */
function assetUrl(payload: unknown): string {
  const url = payload && typeof payload === 'object' ? (payload as { url?: unknown }).url : null
  if (typeof url !== 'string' || /^\s*(javascript|vbscript):/i.test(url)) return ''
  return url
}

/** The plain text of a document up to a position, its blocks a line apart. */
const plain = (doc: ProseNode, to: number) => doc.textBetween(0, to, '\n', '\ufffc')

/** The first position of a document with `count` characters of plain text before it. */
function positionAt(doc: ProseNode, count: number): number {
  let low = 0
  let high = doc.content.size
  while (low < high) {
    const middle = (low + high) >> 1
    if (plain(doc, middle).length >= count) high = middle
    else low = middle + 1
  }
  return low
}

/** A place in a plain text, carried over a change of it: it stays before the change and moves with what follows. */
function carry(at: number, before: string, after: string): number {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  if (at <= start) return at
  if (at >= before.length - end) return at + after.length - before.length
  return Math.min(at, after.length - end)
}

export function applyTheme(theme: Theme | undefined): void {
  if (!theme || typeof theme !== 'object') return
  const root = document.documentElement
  root.dataset.theme = theme.mode === 'light' ? 'light' : 'dark'
  const accent = typeof theme.accent === 'string' && /^#[0-9a-f]{3,8}$/i.test(theme.accent) ? theme.accent : null
  for (const step of ['400', '500', '600']) {
    if (accent) root.style.setProperty(`--color-accent-${step}`, accent)
    else root.style.removeProperty(`--color-accent-${step}`)
  }
  if (accent) root.style.setProperty('--color-accent-300', `color-mix(in srgb, ${accent} 75%, ${theme.mode === 'light' ? 'black' : 'white'})`)
  else root.style.removeProperty('--color-accent-300')
}

/** The bridge, and for the tests: when the queued work is done, the editor of the moment, taking it all away. */
export type BridgeHandle = Bridge & { settled: () => Promise<void>; current: () => NoteEditor | null; destroy: () => Promise<void> }

export function createBridge(host: HTMLElement, post: (message: Message) => void): BridgeHandle {
  const propsBox = document.createElement('div')
  propsBox.className = 'nx-app-properties'
  const editorBox = document.createElement('div')
  editorBox.className = 'nx-note-editor nx-app-editor'
  host.append(propsBox, editorBox)
  const props = createRoot(propsBox)

  let editor: NoteEditor | null = null
  let head = ''
  // The text the app knows the editor holds: what it loaded or set, or what it was told last.
  let told = ''
  let readOnly = false
  let queue: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastState = ''
  let lastHeight = -1
  let asked = 0
  // Per note: the questions waiting for the app, its suggestions (null: asked) and the files it named (undefined: asked).
  let waiting = new Map<string, (payload: unknown) => void>()
  let suggestions = new Map<string, Suggestion[] | null>()
  let assets = new Map<string, string | undefined>()

  const fail = (error: unknown) => post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  const enqueue = (work: () => void | Promise<void>) => {
    queue = queue.then(work).catch(fail)
  }

  const flush = () => {
    timer = null
    if (!editor) return
    told = head + editor.text()
    post({ type: 'change', text: told })
  }
  const changed = () => {
    timer ??= setTimeout(flush, CHANGE_EVERY)
  }
  /** What was typed and not told yet goes now, not after the wait. */
  const flushNow = () => {
    if (timer === null) return
    clearTimeout(timer)
    flush()
  }
  /**
   * A change not yet told goes when another note comes: a `change` after `load` would be taken for the new note. The
   * app that wants it calls `blur` first. A text from outside takes it along (`setText`).
   */
  const drop = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  /** A tap that leads elsewhere: the typing before it is told first, while the app still has this note open. */
  const openLink = (target: string, kind: 'wiki' | 'url' | 'tag') => {
    flushNow()
    post({ type: 'openLink', target, kind })
  }

  const measure = () => {
    const px = Math.ceil(host.getBoundingClientRect().height)
    if (px === lastHeight) return
    lastHeight = px
    post({ type: 'height', px })
  }
  const sizes = new ResizeObserver(measure)
  sizes.observe(host)

  const keyState = (current: NoteEditor): KeyState => {
    const status = current.status()
    const parent = current.view.state.selection.$from.parent
    return {
      bold: status.marks.includes('strong'),
      italic: status.marks.includes('emphasis'),
      heading: parent.type.name === 'heading' ? Number(parent.attrs.level) : 0,
      list: status.list === 'bullet' || status.list === 'ordered',
      task: status.list === 'task',
      canUndo: status.canUndo,
      canRedo: status.canRedo,
    }
  }
  const tell = () => {
    if (!editor) return
    const state = keyState(editor)
    const key = JSON.stringify(state)
    if (key === lastState) return
    lastState = key
    post({ type: 'state', ...state })
  }

  const showHead = () => {
    host.classList.toggle('nx-app-readonly', readOnly)
    props.render(
      createElement(Properties, {
        key: head === '' ? 'none' : 'head',
        head,
        readOnly,
        onChange: (next: string) => {
          head = next
          showHead()
          changed()
        },
      }),
    )
  }

  const search = (kind: 'wiki' | 'tag') => (query: string): Suggestion[] => {
    const key = `${kind}:${query}`
    const known = suggestions.get(key)
    if (known) return known
    if (known === undefined) {
      const forNote = suggestions
      forNote.set(key, null)
      const id = String(++asked)
      waiting.set(id, (payload) => {
        if (forNote !== suggestions) return
        forNote.set(key, suggestionList(payload, kind))
        if (editor) refreshSuggest(editor.view, kind === 'tag' ? tagKey : undefined)
      })
      post({ type: 'suggest', id, kind, query })
    }
    return []
  }

  /** Pictures written as Markdown get their address on their element: ProseMirror leaves a leaf's attributes alone. */
  const showAsset = (path: string, url: string) => {
    if (url) {
      for (const image of editorBox.querySelectorAll<HTMLImageElement>('img[data-nx-src]')) {
        if (assetPath(image.getAttribute('data-nx-src') ?? '') === path) image.src = url
      }
    }
    // Embedded files (`![[…]]`) are drawn again with what is known now.
    editor?.refresh()
  }

  /** The address the app gives a file of the note; undefined while it is asked, '' when the app has none. */
  const asset = (path: string): string | undefined => {
    if (assets.has(path)) return assets.get(path)
    const forNote = assets
    forNote.set(path, undefined)
    const id = String(++asked)
    waiting.set(id, (payload) => {
      if (forNote !== assets) return
      const url = assetUrl(payload)
      forNote.set(path, url)
      showAsset(path, url)
    })
    post({ type: 'asset', id, path })
    return undefined
  }

  const helpers: LinkHelpers = {
    // Which notes exist only the app knows; no link is drawn as missing.
    exists: () => true,
    open: (target) => openLink(target, 'wiki'),
    embed: (target): EmbedShown | null | undefined => {
      const name = target.split('#')[0].split('|')[0].trim()
      if (!isFileTarget(name)) return null
      const kind = fileKind(name)
      if (kind === 'other') return null
      const url = asset(name)
      if (url === undefined) return undefined
      return url ? { url, kind } : null
    },
  }

  /** An embedded PDF's holder (live.ts) shows it in a frame: the app's web view draws PDFs itself. */
  const fillPdfs = () => {
    for (const holder of editorBox.querySelectorAll<HTMLElement>('.nx-embed-pdf')) {
      const url = holder.getAttribute('data-pdf') ?? ''
      if (!url || holder.getAttribute('data-shown') === url) continue
      holder.setAttribute('data-shown', url)
      const section = holder.getAttribute('data-section') ?? ''
      const frame = document.createElement('iframe')
      frame.className = 'nx-app-pdf'
      frame.title = url
      frame.src = section ? `${url}#${section}` : url
      const height = /(?:^|&)height=(\d+)/.exec(section)?.[1]
      if (height) frame.style.height = `${height}px`
      holder.replaceChildren(frame)
    }
  }
  const pdfWatch = new MutationObserver(fillPdfs)
  pdfWatch.observe(editorBox, { childList: true, subtree: true })

  // Links never lead the web view away. Reading, a tap on a web link or a tag opens it in the app; writing, it puts
  // the caret there, as on the note page (wiki links open in both, through `helpers.open`).
  const clicked = (event: MouseEvent) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    const anchor = target?.closest?.('a[href]')
    if (anchor && host.contains(anchor)) {
      event.preventDefault()
      if (readOnly) openLink(anchor.getAttribute('href') ?? '', 'url')
      return
    }
    const tag = target?.closest?.('.nx-tag')
    if (tag && editorBox.contains(tag) && readOnly) {
      event.preventDefault()
      openLink((tag.textContent ?? '').replace(/^#/, ''), 'tag')
    }
  }
  host.addEventListener('click', clicked, true)

  const fontSize = (size: unknown) => {
    if (typeof size === 'number' && size >= 8 && size <= 48) document.documentElement.style.setProperty('--nn-text-size', `${size}px`)
  }

  const command = (current: NoteEditor, name: string, args: Record<string, unknown> | undefined) => {
    const { view } = current
    const known = COMMANDS[name]
    if (known) return current.run(known)
    switch (name) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, Math.round(Number(args?.level) || 1)))
        const parent = view.state.selection.$from.parent
        // The key once more takes the heading back to text.
        if (parent.type.name === 'heading' && Number(parent.attrs.level) === level) return current.run('text')
        if (level <= 3) return current.run(`h${level}` as EditorCommand)
        view.focus()
        return void setBlockType(view.state.schema.nodes.heading, { level })(view.state, view.dispatch)
      }
      case 'callout':
        return current.run('callout', typeof args?.kind === 'string' ? args.kind : undefined)
      case 'table':
        // In a table the page offers rows and columns from a menu; the key only makes one.
        return current.status().table ? undefined : current.run('table')
      case 'tag': {
        view.focus()
        const { from, empty, $from } = view.state.selection
        // Chosen words become the tag; otherwise "#" at the caret, after a blank, and the suggestions open.
        if (!empty) return view.dispatch(view.state.tr.insertText('#', from).scrollIntoView())
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, undefined, '\ufffc')
        return view.dispatch(view.state.tr.insertText(before && !/\s/.test(before) ? ' #' : '#').scrollIntoView())
      }
      case 'insertText':
        view.focus()
        return view.dispatch(view.state.tr.insertText(String(args?.text ?? '')).scrollIntoView())
      default:
        fail(`unknown command: ${name}`)
    }
  }

  return {
    load: (options) => {
      drop()
      applyTheme(options?.theme)
      fontSize(options?.fontSize)
      enqueue(async () => {
        // Work queued before this call may have typed into the old note since.
        drop()
        const previous = editor
        editor = null
        if (previous) await previous.destroy()
        waiting = new Map()
        suggestions = new Map()
        assets = new Map()
        lastState = ''
        readOnly = !!options?.readOnly
        const split = splitNote(String(options?.text ?? ''))
        head = split.head
        told = head + split.body
        showHead()
        const root = document.createElement('div')
        editorBox.replaceChildren(root)
        const labels = editorLabels((key) => i18n.t(key))
        if (typeof options?.placeholder === 'string' && options.placeholder) labels.placeholder = options.placeholder
        const made = await createEditor({
          root,
          original: split.body,
          readOnly,
          labels,
          links: () => helpers,
          search: () => search('wiki'),
          onChange: changed,
          files: {
            src: (written) => {
              const path = assetPath(written)
              return path === null ? written : (asset(path) ?? '')
            },
          },
          plugins: [$prose(() => linkSuggest({ search: () => search('tag'), label: () => i18n.t('tags.title'), key: tagKey, open: TAG_OPEN, close: '' }))],
        })
        editor = made
        made.view.dom.setAttribute('spellcheck', String(options?.spellcheck ?? true))
        made.subscribe(tell)
        // Files the app named while the editor was being made: their embeds are drawn now.
        if ([...assets.values()].some((url) => url !== undefined)) made.refresh()
        tell()
        measure()
      })
    },
    setText: (text) => {
      drop()
      enqueue(() => {
        drop()
        if (!editor) return
        const outside = String(text ?? '')
        // Typing the app was not told of yet is laid onto its text and told after the wait; where the app's text
        // changed that very place, its text is taken.
        const merged = rebase(told, head + editor.text(), outside) ?? outside
        told = outside
        if (merged !== outside) changed()
        const split = splitNote(merged)
        if (split.head !== head) {
          head = split.head
          showHead()
        }
        if (split.body === editor.text()) return
        const { view } = editor
        const { from, to } = view.state.selection
        const old = view.state.doc
        const before = plain(old, old.content.size)
        editor.replace(split.body)
        // The caret stays by the words it stood at, as far as the new text keeps them.
        const { doc } = view.state
        const after = plain(doc, doc.content.size)
        const [anchor, focus] = [from, to].map((at) => positionAt(doc, carry(plain(old, at).length, before, after)))
        view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(focus))))
      })
    },
    setTheme: (theme) => applyTheme(theme),
    setReadOnly: (value) => {
      enqueue(() => {
        readOnly = !!value
        editor?.setReadOnly(readOnly)
        showHead()
      })
    },
    command: (name, args) => {
      enqueue(() => {
        if (editor && !readOnly) command(editor, String(name), args)
      })
    },
    answer: (id, payload) => {
      const receive = waiting.get(String(id))
      if (!receive) return
      waiting.delete(String(id))
      // Never inside the editor's own update, even when an answer comes back at once.
      void Promise.resolve()
        .then(() => receive(payload))
        .catch(fail)
    },
    focus: () => enqueue(() => editor?.view.focus()),
    blur: () => {
      // Leaving the text: what was typed goes now, not after the wait. Typed so far at once, before a `load` that
      // may follow; typed by the calls still queued when they are done.
      flushNow()
      enqueue(() => {
        ;(editor?.view.dom as HTMLElement | undefined)?.blur()
        flushNow()
      })
    },
    settled: () => queue,
    current: () => editor,
    destroy: async () => {
      drop()
      await queue
      sizes.disconnect()
      pdfWatch.disconnect()
      host.removeEventListener('click', clicked, true)
      await editor?.destroy()
      editor = null
      props.unmount()
      propsBox.remove()
      editorBox.remove()
    },
  }
}
