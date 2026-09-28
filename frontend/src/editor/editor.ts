/**
 * The note editor: Milkdown Crepe with the Obsidian layer, the author's style and the block layer.
 *
 * `text()` is what gets saved: the editor's Markdown run through the block layer against the original, so only
 * changed blocks differ from the file. The plan for that is worked out once per original, on the first save.
 *
 * Off on purpose: Crepe's image block (it stores the aspect ratio in the alt text, `![Photo](x)` came back as
 * `![1.00](x)`, and dropped relative images entirely), the empty-line placeholder (it writes `<br />` into the file for
 * every empty paragraph) and the inlining of reference links (it dropped their definitions).
 *
 * Files pasted, dropped or picked from the menu are uploaded through `files` (the page's helpers) and linked with an
 * ordinary relative Markdown link; pictures show through the server (`imageSource`).
 */
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { editorViewCtx, parserCtx, remarkCtx, serializerCtx } from '@milkdown/kit/core'
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import {
  createCodeBlockCommand,
  insertHrCommand,
  liftListItemCommand,
  listItemSchema,
  remarkInlineLinkPlugin,
  remarkPreserveEmptyLinePlugin,
  sinkListItemCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBlockTypeCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark'
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  insertTableCommand,
  toggleStrikethroughCommand,
} from '@milkdown/kit/preset/gfm'
import { redo, redoDepth, undo, undoDepth } from '@milkdown/kit/prose/history'
import type { Node as ProseNode, Schema, Slice } from '@milkdown/kit/prose/model'
import { Fragment, Slice as ProseSlice } from '@milkdown/kit/prose/model'
import { AllSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list'
import { deleteColumn, deleteRow, deleteTable } from '@milkdown/kit/prose/tables'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose, callCommand } from '@milkdown/kit/utils'
import type { Root } from 'mdast'

import { Plan, type Block, type Tools } from './blocks'
import { livePreview, refreshLive, type LinkHelpers } from './live'
import { imageSource, obsidian, replaced, writerOptions } from './obsidian'
import { forcedRaw, holdRaw, keepsLetters, releaseRaw } from './syntax'
import { detectStyle } from './style'
import { linkSuggest, refreshSuggest, type Suggestion } from './suggest'

export type EditorLabels = {
  placeholder: string
  suggestions: string
  link: string
  /** The words a web link gets when nothing was selected for it. */
  linkText: string
  code: { search: string; copy: string; noResult: string; edit: string; hide: string; preview: string; loading: string }
  slash: {
    text: string
    h1: string
    h2: string
    h3: string
    quote: string
    divider: string
    bulletList: string
    orderedList: string
    taskList: string
    code: string
    table: string
    math: string
    groupText: string
    groupList: string
    groupAdvanced: string
    groupObsidian: string
    callout: string
    wikiLink: string
    embed: string
    attachment: string
  }
}

/** An uploaded file, as the note links it. */
export type Inserted = { link: string; name: string; image: boolean }

export type FileHelpers = {
  /** The address a picture the note links is shown from (`Anhänge/Foto%201.png` → the server's address). */
  src: (written: string) => string
  /** Upload files for this note; for each what to link, or null when it was refused (the page says why). */
  upload: (files: File[]) => Promise<(Inserted | null)[]>
}

export type EditorOptions = {
  root: HTMLElement
  /** The note's body (without front matter) as it is on disk. */
  original: string
  readOnly?: boolean
  labels: EditorLabels
  links: () => LinkHelpers
  search: () => (query: string) => Suggestion[]
  /** The document changed (typing, pasting, a command). Cheap: nothing is serialized here. */
  onChange: () => void
  /** Uploading and showing files; without it a pasted or dropped file is refused (`onFileRefused`). */
  files?: FileHelpers
  onFileRefused?: () => void
  /** For tests: more Milkdown plugins, after nexlore's own. */
  plugins?: MilkdownPlugin[]
}

/** What the toolbar, the context menu (and anyone else) can ask of the editor, the same commands as "/". */
export type EditorCommand =
  | 'undo' | 'redo'
  | 'bold' | 'italic' | 'strike' | 'code' | 'highlight' | 'clear' | 'wikiLink' | 'link' | 'embed'
  | 'text' | 'h1' | 'h2' | 'h3' | 'quote' | 'bulletList' | 'orderedList' | 'taskList' | 'indent' | 'outdent'
  | 'codeBlock' | 'math' | 'callout' | 'divider' | 'attachment' | 'selectAll'
  | 'table' | 'rowBefore' | 'rowAfter' | 'colBefore' | 'colAfter' | 'deleteRow' | 'deleteCol' | 'deleteTable'

/** What holds where the caret is: the toolbar lights it. */
export type EditorStatus = {
  /** Marks on the selection (all of it) or at the caret: `strong`, `emphasis`, `strike_through`, `inlineCode`, `link`. */
  marks: string[]
  block: 'text' | 'h1' | 'h2' | 'h3' | 'code' | 'math'
  list: 'bullet' | 'ordered' | 'task' | null
  quote: boolean
  table: boolean
  /** In the head row of a table: no row goes above it, and it stays. */
  headerRow: boolean
  canUndo: boolean
  canRedo: boolean
  canIndent: boolean
  canOutdent: boolean
}

export type NoteEditor = {
  readonly view: EditorView
  /** Runs a command where the selection is; `option` is the kind of a callout. */
  run: (command: EditorCommand, option?: string) => void
  /** What holds where the caret is. */
  status: () => EditorStatus
  /** Told of every change of the document or the selection; returns the way to stop. */
  subscribe: (listener: () => void) => () => void
  readonly tools: Tools
  /** What to save: the editor's Markdown with every unchanged block as it was in the original. */
  text: () => string
  /** The editor's own Markdown for the current document, without the block layer. */
  markdown: () => string
  /** A new original (the file changed elsewhere, nothing typed here): shown without a change of its own. */
  replace: (original: string) => void
  /** Redraw link colours (the list of notes changed). */
  refresh: () => void
  destroy: () => Promise<void>
}

/**
 * Images with a `blob:` or `data:` address would be written into the note as a huge address. A pasted picture comes
 * as a file too and is uploaded (`uploader`); its copy as an address is left out.
 */
function withoutLocalImages(slice: Slice): Slice {
  const strip = (fragment: Fragment): Fragment => {
    const kept: ProseNode[] = []
    fragment.forEach((node) => {
      if (node.type.name === 'image' && /^(blob|data):/i.test(String(node.attrs.src ?? ''))) return
      kept.push(node.isLeaf ? node : node.copy(strip(node.content)))
    })
    return Fragment.from(kept)
  }
  return new ProseSlice(strip(slice.content), slice.openStart, slice.openEnd)
}

/** What an upload puts into the note: the picture itself, or a link with the file's name. */
function insertedNodes(schema: Schema, done: (Inserted | null)[]): ProseNode[] {
  const nodes: ProseNode[] = []
  for (const item of done) {
    if (!item) continue
    if (item.image) nodes.push(schema.nodes.image.create({ src: item.link, alt: '', title: '' }))
    else nodes.push(schema.text(item.name, [schema.marks.link.create({ href: item.link })]))
    nodes.push(schema.text(' '))
  }
  return nodes.slice(0, -1)
}

/** A file picker, for the menu item: the files chosen, or none. */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.addEventListener('change', () => resolve([...(input.files ?? [])]))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

export async function createEditor(options: EditorOptions): Promise<NoteEditor> {
  const { labels } = options
  const style = detectStyle(options.original)
  const icon = (text: string) => `<span class="nx-slash-icon">${text}</span>`
  // A new original from the server is no change of the person typing.
  let quiet = false
  const listeners = new Set<() => void>()

  const crepe = new Crepe({
    root: options.root,
    defaultValue: options.original,
    features: {
      [CrepeFeature.ImageBlock]: false,
      [CrepeFeature.TopBar]: false,
      [CrepeFeature.AI]: false,
    },
    featureConfigs: {
      [CrepeFeature.Placeholder]: { text: labels.placeholder, mode: 'doc' },
      [CrepeFeature.LinkTooltip]: { inputPlaceholder: labels.link },
      [CrepeFeature.CodeMirror]: {
        searchPlaceholder: labels.code.search,
        copyText: labels.code.copy,
        noResultText: labels.code.noResult,
        previewToggleText: (previewOnly: boolean) => (previewOnly ? labels.code.edit : labels.code.hide),
        previewLabel: labels.code.preview,
        previewLoading: labels.code.loading,
      },
      [CrepeFeature.BlockEdit]: {
        textGroup: {
          label: labels.slash.groupText,
          text: { label: labels.slash.text },
          h1: { label: labels.slash.h1 },
          h2: { label: labels.slash.h2 },
          h3: { label: labels.slash.h3 },
          h4: null,
          h5: null,
          h6: null,
          quote: { label: labels.slash.quote },
          divider: { label: labels.slash.divider },
        },
        listGroup: {
          label: labels.slash.groupList,
          bulletList: { label: labels.slash.bulletList },
          orderedList: { label: labels.slash.orderedList },
          taskList: { label: labels.slash.taskList },
        },
        advancedGroup: {
          label: labels.slash.groupAdvanced,
          image: null,
          codeBlock: { label: labels.slash.code },
          table: { label: labels.slash.table },
          math: { label: labels.slash.math },
        },
        buildMenu: (builder) => {
          // Like Crepe's own items: the block's text (the typed "/filter") is replaced.
          const replaceBlock = (ctx: Ctx, make: (view: EditorView) => { node?: ProseNode; text?: string; caret: number }) => {
            const view = ctx.get(editorViewCtx)
            const { $from } = view.state.selection
            const made = make(view)
            let tr = view.state.tr
            if (made.node) tr = tr.replaceWith($from.before(), $from.after(), made.node)
            else tr = tr.insertText(made.text ?? '', $from.start(), $from.end())
            tr = tr.setSelection(TextSelection.create(tr.doc, (made.node ? $from.before() : $from.start()) + made.caret))
            view.dispatch(tr.scrollIntoView())
            view.focus()
          }
          builder
            .addGroup('obsidian', labels.slash.groupObsidian)
            .addItem('wiki-link', { label: labels.slash.wikiLink, icon: icon('[[ ]]'), onRun: (ctx: Ctx) => replaceBlock(ctx, () => ({ text: '[[', caret: 2 })) })
            .addItem('embed', { label: labels.slash.embed, icon: icon('![[ ]]'), onRun: (ctx: Ctx) => replaceBlock(ctx, () => ({ text: '![[', caret: 3 })) })
            .addItem('attachment', {
              label: labels.slash.attachment,
              icon: icon('📎'),
              onRun: (ctx: Ctx) => {
                // The typed "/filter" goes first; the files land where it stood.
                replaceBlock(ctx, () => ({ text: '', caret: 0 }))
                const files = options.files
                if (!files) return options.onFileRefused?.()
                void pickFiles().then(async (chosen) => {
                  if (!chosen.length) return
                  const view = ctx.get(editorViewCtx)
                  const nodes = insertedNodes(view.state.schema, await files.upload(chosen))
                  if (!nodes.length) return
                  view.dispatch(view.state.tr.replaceSelectionWith(nodes.length === 1 ? nodes[0] : view.state.schema.nodes.paragraph.create(null, nodes)).scrollIntoView())
                  view.focus()
                })
              },
            })
            .addItem('callout', {
              label: labels.slash.callout,
              icon: icon('[!]'),
              onRun: (ctx: Ctx) =>
                replaceBlock(ctx, (view) => {
                  const { schema } = view.state
                  const marker = '[!note] '
                  const quote = schema.nodes.blockquote.create(null, schema.nodes.paragraph.create(null, schema.text(marker)))
                  return { node: quote, caret: 2 + marker.length }
                }),
            })
        },
      },
    },
  })

  crepe.editor
    .config(writerOptions(style))
    .config((ctx) => {
      ctx.update(uploadConfig.key, (previous) => ({
        ...previous,
        uploader: async (files: FileList, schema: Schema) => {
          if (!options.files) {
            options.onFileRefused?.()
            return []
          }
          return insertedNodes(schema, await options.files.upload([...files]))
        },
      }))
      if (options.files) ctx.set(imageSource.key, options.files.src)
    })
    .use(obsidian)
    .use(
      $prose(
        () =>
          new Plugin({
            view: () => ({
              update: (view, previous) => {
                if (!quiet && !view.state.doc.eq(previous.doc)) options.onChange()
                for (const listener of listeners) listener()
              },
            }),
            props: { transformPasted: withoutLocalImages },
          }),
      ),
    )
    .use($prose(() => livePreview(options.links)))
    .use($prose(() => linkSuggest({ search: options.search, label: () => labels.suggestions })))
    .use(options.plugins ?? [])
  await crepe.editor.remove([remarkInlineLinkPlugin, remarkPreserveEmptyLinePlugin, ...replaced].flat())
  await crepe.create()
  crepe.setReadonly(!!options.readOnly)

  const ctx = crepe.editor.ctx
  const view = ctx.get(editorViewCtx)
  const parse = ctx.get(parserCtx)
  const serialize = ctx.get(serializerCtx)
  const remark = ctx.get(remarkCtx)

  // The round trip of pieces of the original is asked for more than once (loss check, block layer): kept per original.
  let memo = new Map<string, string>()
  const tools: Tools = {
    serialize: (markdown: string) => {
      let out = memo.get(markdown)
      if (out === undefined) {
        out = serialize(parse(markdown))
        if (markdown.length < 20_000) memo.set(markdown, out)
      }
      return out
    },
    blocks: (markdown: string): Block[] => {
      const tree = remark.parse(markdown) as Root
      return tree.children
        .filter((node) => node.position?.start.offset !== undefined && node.position.end.offset !== undefined)
        .map((node) => ({ start: node.position!.start.offset!, end: node.position!.end.offset! }))
    },
  }

  let original = ''
  let plan: Plan | null = null
  let forcedKeys: string[] = []

  /**
   * Blocks the editor would lose letters or digits of (a node it cannot represent, a Milkdown quirk not yet known)
   * stay raw Markdown: shown as source, never rewritten. Better unwieldy than lost.
   */
  const guard = (text: string): boolean => {
    for (const key of forcedKeys) releaseRaw(key)
    forcedKeys = []
    memo = new Map()
    const lossy = new Set<number>()
    for (const block of tools.blocks(text)) {
      const piece = text.slice(block.start, block.end)
      // Marked by another open editor already: lossy here too (its round trip now comes back raw).
      if (!forcedRaw.has(piece) && keepsLetters(piece, tools.serialize(piece))) continue
      lossy.add(block.start)
      holdRaw(piece, new Set([0]))
      forcedKeys.push(piece)
    }
    if (!lossy.size) return false
    holdRaw(text, lossy)
    forcedKeys.push(text)
    memo = new Map()
    return true
  }

  const show = (text: string) => {
    const doc = parse(text)
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)
    tr.setMeta('addToHistory', false)
    quiet = true
    try {
      view.dispatch(tr)
    } finally {
      quiet = false
    }
  }

  const load = (text: string, always: boolean) => {
    original = text
    plan = null
    if (guard(text) || always) show(text)
  }
  load(options.original, false)

  /** Text around the selection (`==…==`, `[[…]]`); with nothing selected, the caret between the two. */
  const surround = (open: string, close: string) => {
    const { from, to, empty } = view.state.selection
    let tr = view.state.tr.insertText(close, to).insertText(open, from)
    tr = tr.setSelection(TextSelection.create(tr.doc, empty ? from + open.length : to + open.length + close.length))
    view.dispatch(tr.scrollIntoView())
  }

  const attach = () => {
    const files = options.files
    if (!files) return options.onFileRefused?.()
    void pickFiles().then(async (chosen) => {
      if (!chosen.length) return
      const nodes = insertedNodes(view.state.schema, await files.upload(chosen))
      if (!nodes.length) return
      view.dispatch(view.state.tr.replaceSelectionWith(nodes.length === 1 ? nodes[0] : view.state.schema.nodes.paragraph.create(null, nodes)).scrollIntoView())
      view.focus()
    })
  }

  const call = (key: Parameters<typeof callCommand>[0], payload?: unknown) => crepe.editor.action(callCommand(key, payload))

  /** Every mark but links goes (Word's "clear formatting" keeps them too); with nothing selected, for what is typed next. */
  const clear = () => {
    const { from, to, empty } = view.state.selection
    const { marks } = view.state.schema
    let tr = view.state.tr
    if (empty) tr = tr.setStoredMarks([])
    else for (const type of Object.values(marks)) if (type !== marks.link) tr = tr.removeMark(from, to, type)
    view.dispatch(tr)
  }

  /** A web link on the selection, its address asked in Crepe's own box; with nothing selected, on words put there. */
  const webLink = () => {
    let { from, to } = view.state.selection
    if (from === to) {
      view.dispatch(view.state.tr.insertText(labels.linkText, from))
      to = from + labels.linkText.length
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    }
    ;({ from, to } = view.state.selection)
    ctx.get(linkTooltipAPI.key).addLink(from, to)
  }

  const inHeaderRow = () => {
    const { $from } = view.state.selection
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === 'table_header_row') return true
    return false
  }

  const table = (command: (state: typeof view.state, dispatch?: typeof view.dispatch) => boolean) => command(view.state, view.dispatch)

  const status = (): EditorStatus => {
    const { state } = view
    const { $from, from, to, empty } = state.selection
    const marks = empty
      ? (state.storedMarks ?? $from.marks()).map((mark) => mark.type.name)
      : Object.values(state.schema.marks).filter((type) => state.doc.rangeHasMark(from, to, type)).map((type) => type.name)
    const parent = $from.parent
    let block: EditorStatus['block'] = 'text'
    if (parent.type.name === 'heading' && Number(parent.attrs.level) <= 3) block = `h${parent.attrs.level}` as 'h1'
    else if (parent.type.name === 'code_block') block = parent.attrs.language === 'LaTeX' ? 'math' : 'code'
    let list: EditorStatus['list'] = null
    let quote = false
    let inTable = false
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth)
      const name = node.type.name
      if (!list && name === 'list_item' && node.attrs.checked !== null && node.attrs.checked !== undefined) list = 'task'
      else if (!list && name === 'bullet_list') list = 'bullet'
      else if (!list && name === 'ordered_list') list = 'ordered'
      else if (name === 'blockquote') quote = true
      else if (name === 'table') inTable = true
    }
    const item = state.schema.nodes.list_item
    return {
      marks, block, list, quote, table: inTable, headerRow: inTable && inHeaderRow(),
      canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0,
      canIndent: sinkListItem(item)(state), canOutdent: liftListItem(item)(state),
    }
  }

  const run = (command: EditorCommand, option?: string) => {
    view.focus()
    switch (command) {
      case 'undo':
        return undo(view.state, view.dispatch)
      case 'redo':
        return redo(view.state, view.dispatch)
      case 'clear':
        return clear()
      case 'link':
        return webLink()
      case 'embed':
        return surround('![[', ']]')
      case 'indent':
        return call(sinkListItemCommand.key)
      case 'outdent':
        return call(liftListItemCommand.key)
      case 'math':
        return call(createCodeBlockCommand.key, 'LaTeX')
      case 'rowBefore':
        return inHeaderRow() ? undefined : call(addRowBeforeCommand.key)
      case 'rowAfter':
        return call(addRowAfterCommand.key)
      case 'colBefore':
        return call(addColBeforeCommand.key)
      case 'colAfter':
        return call(addColAfterCommand.key)
      case 'deleteRow':
        return inHeaderRow() ? undefined : table(deleteRow)
      case 'deleteCol':
        return table(deleteColumn)
      case 'deleteTable':
        return table(deleteTable)
      case 'bold':
        return call(toggleStrongCommand.key)
      case 'italic':
        return call(toggleEmphasisCommand.key)
      case 'strike':
        return call(toggleStrikethroughCommand.key)
      case 'code':
        return call(toggleInlineCodeCommand.key)
      case 'highlight':
        return surround('==', '==')
      case 'wikiLink':
        return surround('[[', ']]')
      case 'text':
        return call(turnIntoTextCommand.key)
      case 'h1':
      case 'h2':
      case 'h3':
        return call(wrapInHeadingCommand.key, Number(command[1]))
      case 'quote':
        return call(wrapInBlockquoteCommand.key)
      case 'bulletList':
        return call(wrapInBulletListCommand.key)
      case 'orderedList':
        return call(wrapInOrderedListCommand.key)
      case 'taskList':
        return crepe.editor.action((ctx) => callCommand(wrapInBlockTypeCommand.key, { nodeType: listItemSchema.type(ctx), attrs: { checked: false } })(ctx))
      case 'codeBlock':
        return call(createCodeBlockCommand.key)
      case 'callout': {
        // A quote whose first line names the kind, as Obsidian writes it; the paragraph's words become its title.
        call(wrapInBlockquoteCommand.key)
        const { $from } = view.state.selection
        const kind = /^[a-z-]+$/.test(option ?? '') ? option : 'note'
        return view.dispatch(view.state.tr.insertText(`[!${kind}] `, $from.start()).scrollIntoView())
      }
      case 'table':
        return call(insertTableCommand.key, { row: 3, col: 3 })
      case 'divider':
        return call(insertHrCommand.key)
      case 'attachment':
        return attach()
      case 'selectAll':
        return view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))
    }
  }

  return {
    view,
    tools,
    run,
    status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    markdown: () => serialize(view.state.doc),
    text: () => {
      const edited = serialize(view.state.doc)
      plan ??= new Plan(original, tools)
      return plan.apply(edited, tools)
    },
    replace: (next: string) => load(next, true),
    refresh: () => {
      refreshLive(view)
      refreshSuggest(view)
    },
    destroy: async () => {
      for (const key of forcedKeys) releaseRaw(key)
      await crepe.destroy()
    },
  }
}
