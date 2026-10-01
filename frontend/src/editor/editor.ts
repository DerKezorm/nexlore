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
import { foldPlugin, type FoldStore } from './folds'
import { moveBlock, moveBlockKeys } from './moveBlock'
import { topLevelDrop } from './drop'
import { keepShiftTab } from './indent'
import { alignColumn, sortByColumn, tableTabKeys } from './tables'
import { cleanPastedHtml, keepFirstBlock, pastedCode } from './pasted'
import { byUse, noteSlashUse } from './slashUse'
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { editorViewCtx, editorViewOptionsCtx, parserCtx, remarkCtx, serializerCtx } from '@milkdown/kit/core'
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
  syncListOrderPlugin,
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
import type { Mark, Node as ProseNode, Schema, Slice } from '@milkdown/kit/prose/model'
import { Fragment, Slice as ProseSlice } from '@milkdown/kit/prose/model'
import { AllSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list'
import { deleteColumn, deleteRow, deleteTable } from '@milkdown/kit/prose/tables'
import { wrapInList } from '@milkdown/kit/prose/schema-list'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose, callCommand } from '@milkdown/kit/utils'
import type { Root, RootContent } from 'mdast'

import { Plan, type Block, type Tools } from './blocks'
import { findControl, findPlugin, type FindControl } from './find'
import { commentControl, commentPlugin, type CommentControl } from './commentMarks'
import { dateSuggest } from './dateSuggest'
import { taskTicks } from './taskTicks'
import { keepListOrder } from './listOrder'
import { listItemView } from './listItemView'
import { listItemBlockView } from '@milkdown/kit/component/list-item-block'
import { lineNumbers, type LineControl } from './lineNumbers'
import { livePreview, refreshLive, type LinkHelpers } from './live'
import { blockPreviews } from './previews'
import { imageSource, obsidian, replaced, writerOptions } from './obsidian'
import { dollarText } from './dollars'
import { describeSlashMenu } from './slashAria'
import { forcedRaw, holdRaw, keepsLetters, releaseRaw } from './syntax'
import { detectStyle } from './style'
import { linkSuggest, refreshSuggest, type Suggestion } from './suggest'

export type EditorLabels = {
  placeholder: string
  suggestions: string
  link: string
  /** The words a web link gets when nothing was selected for it. */
  linkText: string
  /** What the two buttons beside a block do (Crepe draws them without a word). */
  handle: { add: string; drag: string }
  /** Dates in words after "@": the list's name and the line that says what Enter and Shift+Enter write. */
  dates: { list: string; hint: string; dayName?: (iso: string) => string }
  code: { search: string; copy: string; noResult: string; edit: string; hide: string; preview: string; loading: string }
  slash: {
    text: string
    h1: string
    h2: string
    h3: string
    h4: string
    h5: string
    h6: string
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
    image: string
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

/** A speech bubble with a pen, drawn like Crepe's own symbols (24 by 24, filled with the text colour). */
/** Crepe's code icon without its clip path: the clip covered the whole icon and did nothing, and its fixed id stood
 * twice on the page (slash menu and selection bar), which a page must not have (P8.19). Same drawing, no id. */
const CODE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12L9.4 7.4L8 6L2 12L8 18L9.4 16.6ZM14.6 16.6L19.2 12L14.6 7.4L16 6L22 12L16 18L14.6 16.6Z"/></svg>'

const COMMENT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v10h2v2l2.5-2H20V6zm3 7.5 5.6-5.6 2 2L9 15.5H7z"/></svg>'

export type EditorOptions = {
  /** "Comment" in the bar over chosen words; without it the bar has no such button. */
  comment?: { label: string; run: () => void }
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
  /** The note's folds (`editor/folds.ts`); without it nothing folds. */
  folds?: FoldStore
  /** The title of a pasted web address, for its link's words; null at once when titles are not asked for. */
  linkTitle?: (url: string) => Promise<string | null> | null
  /** For tests: more Milkdown plugins, after nexlore's own. */
  plugins?: MilkdownPlugin[]
}

/** What the toolbar, the context menu (and anyone else) can ask of the editor, the same commands as "/". */
export type EditorCommand =
  | 'undo' | 'redo'
  | 'bold' | 'italic' | 'strike' | 'code' | 'highlight' | 'clear' | 'wikiLink' | 'link' | 'embed'
  | 'text' | 'h1' | 'h2' | 'h3' | 'quote' | 'bulletList' | 'orderedList' | 'taskList' | 'indent' | 'outdent'
  | 'codeBlock' | 'math' | 'callout' | 'divider' | 'attachment' | 'selectAll' | 'moveUp' | 'moveDown'
  | 'table' | 'rowBefore' | 'rowAfter' | 'colBefore' | 'colAfter' | 'deleteRow' | 'deleteCol' | 'deleteTable'
  | 'alignNone' | 'alignLeft' | 'alignCenter' | 'alignRight' | 'sortAsc' | 'sortDesc'

/** A piece of the note for the AI, and where it stood (read when the AI is asked: a dialog takes the selection away). */
export type AiScope = { markdown: string; from: number; to: number; whole: boolean }

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
  /** What the AI works on: the selection as Markdown, or the whole text when nothing is selected; and where it was. */
  aiScope: () => AiScope
  /** Markdown in place of what `aiScope` gave, as one step that undo takes back. */
  replaceMarkdown: (markdown: string, scope: AiScope) => void
  /** Markdown after the block the caret is in. */
  insertMarkdown: (markdown: string) => void
  readonly tools: Tools
  /** Find and replace in the text (the bar above the editor). */
  readonly find: FindControl
  /** The words of the open comment threads, marked in the text. */
  readonly comments: CommentControl
  /** What to save: the editor's Markdown with every unchanged block as it was in the original. */
  text: () => string
  /** The file's line numbers beside the text, the body starting on line `first`; null hides them. */
  lineNumbers: (first: number | null) => void
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

/** An address alone on the clipboard (web or mail), as it would become a link; null for anything else. */
export function pastedAddress(text: string): string | null {
  const address = text.trim()
  if (!address || /\s/.test(address)) return null
  if (/^https?:\/\/[^/\s]+\.[^\s]*$/i.test(address) || /^https?:\/\/localhost(:\d+)?(\/\S*)?$/i.test(address)) return address
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(address)) return address
  return null
}

/**
 * An address pasted onto chosen words makes them a link to it (in one block; across blocks it is pasted as text).
 * The words stay, the selection with them, so another format can follow.
 */
function pasteOntoWords(view: EditorView, pasted: string): boolean {
  const { from, to, empty, $from, $to } = view.state.selection
  if (empty || !$from.sameParent($to) || $from.parent.type.spec.code) return false
  const href = pastedAddress(pasted)
  if (!href) return false
  const link = view.state.schema.marks.link
  view.dispatch(view.state.tr.removeMark(from, to, link).addMark(from, to, link.create({ href })))
  return true
}

/**
 * A web address pasted where nothing is chosen, while titles are asked for: it goes in as a link to itself, and its
 * words become the page's title once that comes (if the link is still there as it was pasted).
 */
function pasteTitled(view: EditorView, pasted: string, linkTitle?: EditorOptions['linkTitle']): boolean {
  const { empty, $from } = view.state.selection
  if (!linkTitle || !empty || $from.parent.type.spec.code) return false
  const href = pastedAddress(pasted)
  if (!href || !/^https?:/i.test(href)) return false
  const asked = linkTitle(href)
  if (!asked) return false
  const link = view.state.schema.marks.link
  view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.text(href, [link.create({ href })]), false).scrollIntoView())
  void asked.then((title) => {
    if (!title || view.isDestroyed) return
    let at = -1
    let marks: readonly Mark[] = []
    view.state.doc.descendants((node, pos) => {
      if (at >= 0) return false
      if (node.isText && node.text === href && node.marks.some((mark) => mark.type === link && mark.attrs.href === href)) {
        at = pos
        marks = node.marks
      }
      return true
    })
    if (at >= 0) view.dispatch(view.state.tr.replaceWith(at, at + href.length, view.state.schema.text(title, marks)))
  })
  return true
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

/**
 * Uploaded files at the caret, as inline content with their own marks. `replaceSelectionWith` gave a single node the
 * marks around the caret instead, and so took the link off a file's name: a PDF came in as its bare name.
 */
export function insertFiles(view: EditorView, nodes: ProseNode[]): void {
  view.dispatch(view.state.tr.replaceSelection(new ProseSlice(Fragment.fromArray(nodes), 0, 0)).scrollIntoView())
}

/**
 * The chosen paragraphs as a list, one item each (`wrapInList` splits the range; `task`: every new item a task). False
 * when the selection is not a run of paragraphs outside a list: Milkdown's own command takes over then.
 */
function listEach(view: EditorView, listType: 'bullet_list' | 'ordered_list', task = false): boolean {
  const { state } = view
  const { $from, $to } = state.selection
  const range = $from.blockRange($to)
  if (!range || range.parent.type.name === 'list_item' || range.endIndex - range.startIndex < 2) return false
  for (let index = range.startIndex; index < range.endIndex; index++) if (range.parent.child(index).type.name !== 'paragraph') return false
  let done = false
  wrapInList(state.schema.nodes[listType])(state, (tr) => {
    if (task) {
      const from = tr.mapping.map(range.start)
      const to = tr.mapping.map(range.end, 1)
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'list_item') tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false })
      })
    }
    view.dispatch(tr.scrollIntoView())
    done = true
  })
  return done
}

/** A file picker, for the menu items: the files chosen, or none; `accept` narrows what may be chosen. */
function pickFiles(accept?: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    if (accept) input.accept = accept
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
  const lines: LineControl = { set: () => {} }
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
      // "Comment" in the bar over chosen words, after Crepe's own buttons. It stood below the words before and covered
      // the next line (review before 1.0.0, P3.11).
      [CrepeFeature.Toolbar]: options.comment
        ? {
            codeIcon: CODE_ICON,
            buildToolbar: (builder) => {
              builder.addGroup('nx-comment', options.comment!.label).addItem('comment', {
                icon: COMMENT_ICON,
                label: options.comment!.label,
                active: () => false,
                onRun: () => options.comment!.run(),
              })
            },
          }
        : { codeIcon: CODE_ICON },
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
          h4: { label: labels.slash.h4 },
          h5: { label: labels.slash.h5 },
          h6: { label: labels.slash.h6 },
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
          codeBlock: { label: labels.slash.code, icon: CODE_ICON },
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
          // Files chosen in a picker land where the typed "/filter" stood.
          const uploadPicked = (ctx: Ctx, accept?: string) => {
            replaceBlock(ctx, () => ({ text: '', caret: 0 }))
            const files = options.files
            if (!files) return options.onFileRefused?.()
            void pickFiles(accept).then(async (chosen) => {
              if (!chosen.length) return
              const view = ctx.get(editorViewCtx)
              const nodes = insertedNodes(view.state.schema, await files.upload(chosen))
              if (!nodes.length) return
              insertFiles(view, nodes)
              view.focus()
            })
          }
          // Crepe's own picture block writes the alt text wrong (see obsidian.ts); this one uploads like pasting.
          builder.getGroup('advanced').addItem('picture', { label: labels.slash.image, icon: icon('🖼'), onRun: (ctx: Ctx) => uploadPicked(ctx, 'image/*') })
          builder
            .addGroup('obsidian', labels.slash.groupObsidian)
            .addItem('wiki-link', { label: labels.slash.wikiLink, icon: icon('[[ ]]'), onRun: (ctx: Ctx) => replaceBlock(ctx, () => ({ text: '[[', caret: 2 })) })
            .addItem('embed', { label: labels.slash.embed, icon: icon('![[ ]]'), onRun: (ctx: Ctx) => replaceBlock(ctx, () => ({ text: '![[', caret: 3 })) })
            .addItem('attachment', {
              label: labels.slash.attachment,
              icon: icon('📎'),
              onRun: (ctx: Ctx) => uploadPicked(ctx),
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
          // The entries used most come first in their group; each choice is counted.
          for (const group of builder.build()) {
            for (const item of group.items) {
              const run = item.onRun
              item.onRun = (ctx: Ctx) => {
                noteSlashUse(item.key)
                run?.(ctx)
              }
            }
            group.items = byUse(group.items)
          }
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
      // On a phone the toolbar sits at the bottom: the line being written stays above it (P8.6).
      const bottom = window.matchMedia?.('(max-width: 639px)').matches ? 88 : 5
      ctx.update(editorViewOptionsCtx, (previous) => ({
        ...previous,
        scrollMargin: { top: 5, left: 5, right: 5, bottom },
        scrollThreshold: { top: 0, left: 0, right: 0, bottom: bottom === 5 ? 0 : 72 },
      }))
    })
    .use(obsidian)
    .use(dollarText)
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
            props: {
              transformPastedHTML: cleanPastedHtml,
              transformPasted: (slice: Slice) => keepFirstBlock(withoutLocalImages(slice)),
              handleDOMEvents: {
                // On the event itself, before Milkdown's own paste: that one takes an address as Markdown and puts
                // it in place of the chosen words (a handlePaste here never came to be asked).
                paste: (view, event) => {
                  // Several lines from a code editor: a code block with its language, not paragraphs (`pastedCode`).
                  const code = view.state.selection.$from.parent.type.spec.code ? null : pastedCode(event.clipboardData)
                  if (code) {
                    const { schema } = view.state
                    const block = schema.nodes.code_block.create({ language: code.language }, code.text ? schema.text(code.text) : null)
                    view.dispatch(view.state.tr.replaceSelectionWith(block).scrollIntoView())
                    event.preventDefault()
                    return true
                  }
                  const pasted = event.clipboardData?.getData('text/plain') ?? ''
                  if (!pasteOntoWords(view, pasted) && !pasteTitled(view, pasted, options.linkTitle)) return false
                  event.preventDefault()
                  return true
                },
              },
            },
          }),
      ),
    )
    .use($prose(() => livePreview(options.links)))
    .use($prose(() => blockPreviews()))
    .use($prose(() => findPlugin()))
    .use($prose(() => commentPlugin()))
    .use($prose(() => moveBlockKeys()))
    .use($prose(() => topLevelDrop()))
    .use($prose(() => tableTabKeys()))
    .use($prose(() => keepShiftTab()))
    .use($prose(() => (options.folds ? foldPlugin(options.folds) : new Plugin({}))))
    .use(
      $prose(() =>
        lineNumbers(
          {
            text: () => saved(),
            blocks: (markdown) => tools.blocks(markdown),
            serialize: (markdown) => tools.serialize(markdown),
            write: (node) => {
              let out = written.get(node)
              if (out === undefined) {
                out = serialize(view.state.schema.topNodeType.create(null, [node]))
                written.set(node, out)
              }
              return out
            },
            parts: (markdown) => {
              const found: number[] = []
              const walk = (node: RootContent | Root) => {
                if ((node.type === 'listItem' || node.type === 'tableRow') && node.position?.start.offset !== undefined)
                  found.push(node.position.start.offset)
                if ('children' in node) for (const child of node.children) walk(child as RootContent)
              }
              walk(remark.parse(markdown) as Root)
              return found
            },
          },
          lines,
        ),
      ),
    )
    .use($prose(() => linkSuggest({ search: options.search, label: () => labels.suggestions })))
    .use($prose(() => dateSuggest(() => ({ ...labels.dates, locale: () => document.documentElement.lang || navigator.language }))))
    .use($prose(() => taskTicks()))
    .use(keepListOrder)
    .use(listItemView)
    .use(options.plugins ?? [])
  // Milkdown's own walked the whole note after every transaction (listOrder.ts); its list item view set the selection
  // back to an old place after fast typing (listItemView.ts).
  await crepe.editor.remove([remarkInlineLinkPlugin, remarkPreserveEmptyLinePlugin, syncListOrderPlugin, listItemBlockView, ...replaced].flat())
  await crepe.create()
  crepe.setReadonly(!!options.readOnly)
  const stopSlashAria = describeSlashMenu(options.root, crepe.editor.ctx.get(editorViewCtx).dom, labels.slash.groupText)
  // The "+" and the eight dots beside a block: a tooltip each, and a name for screen readers. Crepe draws them a
  // moment after the editor is there, so they are named when they come.
  const nameHandle = () => {
    const [addButton, dragButton] = options.root.querySelectorAll<HTMLElement>('.milkdown-block-handle .operation-item')
    if (!dragButton) return false
    for (const [button, label] of [[addButton, labels.handle.add], [dragButton, labels.handle.drag]] as const) {
      button.title = label
      button.setAttribute('role', 'button')
      button.setAttribute('aria-label', label)
    }
    return true
  }
  const handleWatch = new MutationObserver(() => nameHandle() && handleWatch.disconnect())
  if (!nameHandle()) handleWatch.observe(options.root, { childList: true, subtree: true })

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
  /** What one top-level node writes, kept per node (unchanged nodes stay the same object). */
  const written = new WeakMap<ProseNode, string>()
  const saved = (): string => {
    const edited = serialize(view.state.doc)
    plan ??= new Plan(original, tools)
    return plan.apply(edited, tools)
  }
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
      insertFiles(view, nodes)
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

  const aiScope = (): AiScope => {
    const { from, to, empty } = view.state.selection
    const size = view.state.doc.content.size
    if (empty || (from <= 1 && to >= size - 1)) return { markdown: serialize(view.state.doc), from: 0, to: size, whole: true }
    // The selection with the blocks around it cut down to it: a sentence out of a paragraph is that sentence.
    return { markdown: serialize(view.state.doc.cut(from, to)), from, to, whole: false }
  }

  const replaceMarkdown = (markdown: string, scope: AiScope) => {
    const parsed = parse(markdown)
    let tr = view.state.tr
    if (scope.whole) tr = tr.replaceWith(0, view.state.doc.content.size, parsed.content)
    else {
      // One paragraph back for words out of a paragraph: its words go in place, not a paragraph of their own.
      const inline = parsed.childCount === 1 && parsed.firstChild?.type.name === 'paragraph'
      tr = tr.replaceRange(scope.from, scope.to, new ProseSlice(parsed.content, inline ? 1 : 0, inline ? 1 : 0))
    }
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  const insertMarkdown = (markdown: string) => {
    const parsed = parse(markdown)
    const { $to } = view.state.selection
    const at = $to.depth >= 1 ? $to.after(1) : view.state.selection.to
    view.dispatch(view.state.tr.insert(at, parsed.content).scrollIntoView())
    view.focus()
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
      // Several paragraphs chosen: one list item each, as Word and Notion do (Milkdown's own made one item of all).
      case 'bulletList':
        return listEach(view, 'bullet_list') || call(wrapInBulletListCommand.key)
      case 'orderedList':
        return listEach(view, 'ordered_list') || call(wrapInOrderedListCommand.key)
      case 'taskList':
        return (
          listEach(view, 'bullet_list', true) ||
          crepe.editor.action((ctx) => callCommand(wrapInBlockTypeCommand.key, { nodeType: listItemSchema.type(ctx), attrs: { checked: false } })(ctx))
        )
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
      case 'alignNone':
        return void alignColumn(null)(view.state, view.dispatch)
      case 'alignLeft':
        return void alignColumn('left')(view.state, view.dispatch)
      case 'alignCenter':
        return void alignColumn('center')(view.state, view.dispatch)
      case 'alignRight':
        return void alignColumn('right')(view.state, view.dispatch)
      case 'sortAsc':
        return void sortByColumn(1)(view.state, view.dispatch)
      case 'sortDesc':
        return void sortByColumn(-1)(view.state, view.dispatch)
      case 'moveUp':
        return void moveBlock(-1)(view.state, view.dispatch)
      case 'moveDown':
        return void moveBlock(1)(view.state, view.dispatch)
    }
  }

  return {
    view,
    tools,
    find: findControl(view),
    comments: commentControl(view),
    run,
    status,
    aiScope,
    replaceMarkdown,
    insertMarkdown,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    markdown: () => serialize(view.state.doc),
    text: saved,
    lineNumbers: (first) => lines.set(first),
    replace: (next: string) => load(next, true),
    refresh: () => {
      refreshLive(view)
      refreshSuggest(view)
    },
    destroy: async () => {
      handleWatch.disconnect()
      stopSlashAria()
      for (const key of forcedKeys) releaseRaw(key)
      await crepe.destroy()
    },
  }
}
