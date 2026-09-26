/**
 * The Obsidian layer as Milkdown plugins: the syntax from syntax.ts for parser and writer, two nodes for raw
 * Markdown, and the author's style for everything written anew.
 */
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { bulletListSchema, codeBlockSchema, imageSchema, linkSchema, orderedListSchema } from '@milkdown/kit/preset/commonmark'
import { $ctx, $node, $remark } from '@milkdown/kit/utils'
import { gfmTableToMarkdown } from 'mdast-util-gfm-table'
import type { Options } from 'mdast-util-to-markdown'
import { defaultHandlers } from 'mdast-util-to-markdown'

import { safeUrl } from '../lib/markdown'

import type { Style } from './style'
import {
  attention,
  formLink,
  indentedListItem,
  keepRaw,
  markedListWriter,
  tidyRoot,
  wikiFromMarkdown,
  wikiSyntax,
  writeRaw,
  writeText,
  writtenCode,
  type LinkForm,
} from './syntax'

type Data = { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] }

const obsidianRemark = $remark('nxObsidian', () =>
  function (this: { data: () => Data }) {
    const data = this.data()
    ;(data.micromarkExtensions ??= []).push(wikiSyntax)
    ;(data.fromMarkdownExtensions ??= []).push(wikiFromMarkdown)
    return keepRaw()
  } as never,
)

/** Markdown the editor has no own node for, as a block: shown as its source, written back unchanged. */
const rawBlock = $node('nx_raw_block', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  selectable: true,
  attrs: { value: { default: '' } },
  parseDOM: [{ tag: 'pre[data-nx-raw]', getAttrs: (dom) => ({ value: (dom as HTMLElement).textContent ?? '' }) }],
  toDOM: (node) => ['pre', { 'data-nx-raw': '', class: 'nx-raw-block', spellcheck: 'false' }, node.attrs.value as string],
  parseMarkdown: {
    match: (node) => node.type === 'nxRawBlock',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'nx_raw_block',
    runner: (state, node) => {
      state.addNode('nxRaw', undefined, node.attrs.value as string)
    },
  },
}))

/** The same inline: a reference link `[text][ref]` shows its text and keeps its source. */
const rawInline = $node('nx_raw_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { value: { default: '' } },
  parseDOM: [{ tag: 'span[data-nx-raw]', getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.nxRaw ?? '' }) }],
  toDOM: (node) => {
    const value = node.attrs.value as string
    const label = /^!?\[([^\]]*)\]/.exec(value)?.[1] || value
    return ['span', { 'data-nx-raw': value, class: 'nx-raw-inline', title: value }, label]
  },
  leafText: (node) => node.attrs.value as string,
  parseMarkdown: {
    match: (node) => node.type === 'nxRawInline',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'nx_raw_inline',
    runner: (state, node) => {
      state.addNode('nxRaw', undefined, node.attrs.value as string)
    },
  },
}))

/** The writer's options: Obsidian's syntax kept, the author's style for what is new. Before the editor starts. */
export function writerOptions(style: Style) {
  return (ctx: Ctx) => {
    // Tables padded into columns only where the author's tables are (handlers here win over remark-gfm's).
    const tables = gfmTableToMarkdown({ tableCellPadding: true, tablePipeAlign: style.alignTables }).handlers
    ctx.update(remarkStringifyOptionsCtx, (options: Options) => ({
      ...options,
      bullet: style.bullet,
      bulletOther: style.bulletOther,
      emphasis: style.emphasis,
      strong: style.strong,
      fence: style.fence,
      fences: style.fences,
      rule: style.rule,
      setext: style.setext,
      handlers: {
        ...options.handlers,
        ...tables,
        text: writeText,
        nxRaw: writeRaw,
        link: formLink(options.handlers?.link ?? defaultHandlers.link, style.bareUrls),
        listItem: indentedListItem(style.listIndent),
        code: writtenCode(options.handlers?.code ?? defaultHandlers.code),
        list: markedListWriter(defaultHandlers.list),
        strong: attention('strong', defaultHandlers.strong),
        emphasis: attention('emphasis', defaultHandlers.emphasis),
        root: tidyRoot(options.handlers?.root ?? defaultHandlers.root),
      },
    }))
  }
}

/** Where the page shows a picture a note links (`Anhänge/Foto%201.png`): set by the editor, the same by default. */
export const imageSource = $ctx<(src: string) => string, 'nxImageSource'>((src) => src, 'nxImageSource')

/** Milkdown's link, plus how it was written (see `LinkForm`). Replaces the preset's link. */
export const formedLink = linkSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx)
  return {
    ...base,
    attrs: { ...base.attrs, form: { default: '' } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, markType) => {
        const form = (node.data as { nxForm?: LinkForm } | undefined)?.nxForm ?? ''
        state.openMark(markType, { href: node.url as string, title: node.title as string, form })
        state.next(node.children)
        state.closeMark(markType)
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, mark) => {
        state.withMark(mark, 'link', undefined, { title: mark.attrs.title, url: mark.attrs.href, data: { nxForm: mark.attrs.form } })
      },
    },
  }
})

/**
 * Milkdown's image demands a title as text; Markdown images without one (nearly all) have none, the parser throws,
 * and Milkdown drops the image with nothing but a line in the console. Missing alt text and title become empty.
 */
export const safeImage = imageSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx)
  return {
    ...base,
    // Links are cleaned by Milkdown; images were not. Only the web and paths in the vault reach the page, and a path
    // in the vault is shown through the server (`imageSource`); the node keeps what the note says.
    toDOM: (node) => {
      const shown = base.toDOM!(node) as [string, Record<string, unknown>]
      const src = String(node.attrs.src ?? '')
      const allowed = safeUrl(src) && !/^mailto:/i.test(src)
      return [shown[0], { ...shown[1], src: allowed ? ctx.get(imageSource.key)(src) : '', 'data-src': src }]
    },
    // Copied inside the editor, a picture carries the address it is shown from; the note's own path comes back.
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          const element = dom as HTMLElement
          return {
            src: element.getAttribute('data-src') ?? element.getAttribute('src') ?? '',
            alt: element.getAttribute('alt') ?? '',
            title: element.getAttribute('title') ?? element.getAttribute('alt') ?? '',
          }
        },
      },
    ],
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        state.addNode(type, { src: String(node.url ?? ''), alt: String(node.alt ?? ''), title: String(node.title ?? '') })
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.addNode('image', undefined, undefined, { title: node.attrs.title || null, url: node.attrs.src, alt: node.attrs.alt })
      },
    },
  }
})

/**
 * Milkdown's code block, plus the rest of the fence line (```` ```js title="x" ````, it was dropped) and how the
 * block was written: with backticks, with tildes, or indented.
 */
export const fullCodeBlock = codeBlockSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx)
  return {
    ...base,
    attrs: { ...base.attrs, meta: { default: '' }, fence: { default: '' } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const fence = (node.data as { nxFence?: string } | undefined)?.nxFence ?? ''
        state.openNode(type, { language: node.lang ?? '', meta: node.meta ?? '', fence })
        if (node.value) state.addText(node.value as string)
        state.closeNode()
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        // Crepe shows a `$$` math block as a code block in LaTeX; it goes back as `$$`, not as ```LaTeX (Obsidian
        // would show that as code). A fenced block the author wrote in LaTeX stays fenced.
        const fence = node.attrs.fence as string
        if (String(node.attrs.language).toLowerCase() === 'latex' && fence !== '`' && fence !== '~' && fence !== 'indent') {
          state.addNode('math', undefined, node.content.firstChild?.text || '')
          return
        }
        state.addNode('code', undefined, node.content.firstChild?.text || '', {
          lang: node.attrs.language || null,
          meta: node.attrs.meta || null,
          data: { nxFence: node.attrs.fence },
        })
      },
    },
  }
})

/**
 * Lists remember their marker (`-`, `*`, `+`; `.` or `)` after a number): two lists next to each other are two
 * lists only because their markers differ, and a list written anew with the file's usual marker merged into its
 * neighbour.
 */
function markedList<T extends typeof bulletListSchema | typeof orderedListSchema>(schema: T, ordered: boolean) {
  return schema.extendSchema((previous) => (ctx) => {
    const base = previous(ctx)
    return {
      ...base,
      attrs: { ...base.attrs, marker: { default: '' } },
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const marker = (node.data as { nxMarker?: string } | undefined)?.nxMarker ?? ''
          const spread = node.spread ?? !ordered
          state.openNode(type, ordered ? { spread, order: node.start ?? 1, marker } : { spread, marker })
          state.next(node.children)
          state.closeNode()
        },
      },
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          state.openNode('list', undefined, {
            ordered,
            ...(ordered ? { start: node.attrs.order ?? 1 } : {}),
            spread: node.attrs.spread,
            data: { nxMarker: node.attrs.marker },
          })
          state.next(node.content)
          state.closeNode()
        },
      },
    }
  })
}

export const obsidian = [
  obsidianRemark,
  rawBlock,
  rawInline,
  formedLink,
  imageSource,
  safeImage,
  fullCodeBlock,
  markedList(bulletListSchema, false),
  markedList(orderedListSchema, true),
].flat()

/** The preset's own versions of what `obsidian` replaces. */
export const replaced = [linkSchema, imageSchema, codeBlockSchema, bulletListSchema, orderedListSchema].flat()
