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
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { remarkInlineLinkPlugin, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark'
import type { Node as ProseNode, Schema, Slice } from '@milkdown/kit/prose/model'
import { Fragment, Slice as ProseSlice } from '@milkdown/kit/prose/model'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { Root } from 'mdast'

import { Plan, type Block, type Tools } from './blocks'
import { livePreview, refreshLive, type LinkHelpers } from './live'
import { imageSource, obsidian, replaced, writerOptions } from './obsidian'
import { forcedRaw, holdRaw, keepsLetters, releaseRaw } from './syntax'
import { detectStyle } from './style'
import { linkSuggest, type Suggestion } from './suggest'

export type EditorLabels = {
  placeholder: string
  suggestions: string
  link: string
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

export type NoteEditor = {
  readonly view: EditorView
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

  return {
    view,
    tools,
    markdown: () => serialize(view.state.doc),
    text: () => {
      const edited = serialize(view.state.doc)
      plan ??= new Plan(original, tools)
      return plan.apply(edited, tools)
    },
    replace: (next: string) => load(next, true),
    refresh: () => refreshLive(view),
    destroy: async () => {
      for (const key of forcedKeys) releaseRaw(key)
      await crepe.destroy()
    },
  }
}
