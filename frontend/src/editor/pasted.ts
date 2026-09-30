/**
 * Formatted text pasted from a web page, Word or Google Docs: Milkdown makes Markdown of most of it (tables, lists,
 * links, emphasis, headings). What it did not, measured and mended here:
 *
 * - Word writes its lists as paragraphs with `mso-list` and a bullet or number of its own in front: they become lists
 *   (nested by level, numbered where Word numbered them), the bullet goes.
 * - A code block's language (`language-js`, `lang-python` on `pre` or `code`) was lost, and a last line break became
 *   an empty line in the block.
 * - Pasted at the end of a line with words, the first block of what came from outside ran into that line: a heading,
 *   a list, a code block became plain words. Such a block now stays a block of its own. (Words copied inside the
 *   editor keep their way: the editor's own copy says so, `data-pm-slice`.)
 */
import { Slice, type Node as ProseNode } from '@milkdown/kit/prose/model'

const LEVEL = /mso-list:\s*l\d+\s+level(\d+)/i
/** Word's own bullet or number in front of a list paragraph. */
const MARKER = /^[\s\u00a0]*([·•o§▪\u2013\u2014-]|\d{1,3}[.)]|[a-zA-Z][.)]|[ivxlcdmIVXLCDM]{1,6}[.)])[\s\u00a0]*$/
const ORDERED = /^[\s\u00a0]*(\d{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)]/

function wordLists(doc: Document): void {
  const paragraphs = [...doc.querySelectorAll('p')].filter((p) => LEVEL.test(p.getAttribute('style') ?? ''))
  const done = new Set<Element>()
  for (const first of paragraphs) {
    if (done.has(first)) continue
    // One run: list paragraphs one right after the other.
    const run: HTMLElement[] = []
    for (let at: Element | null = first; at && at.tagName === 'P' && LEVEL.test(at.getAttribute('style') ?? ''); at = at.nextElementSibling) {
      run.push(at as HTMLElement)
      done.add(at)
    }
    const root = doc.createElement('div')
    const stack: { level: number; list: HTMLElement }[] = []
    for (const paragraph of run) {
      const level = Number(LEVEL.exec(paragraph.getAttribute('style') ?? '')![1])
      const marker = [...paragraph.children].find((child) => MARKER.test(child.textContent ?? ''))
      const ordered = ORDERED.test(marker?.textContent ?? '')
      marker?.remove()
      while (stack.length && stack[stack.length - 1].level > level) stack.pop()
      if (!stack.length || stack[stack.length - 1].level < level) {
        const list = doc.createElement(ordered ? 'ol' : 'ul')
        const parent = stack.length ? stack[stack.length - 1].list.lastElementChild ?? stack[stack.length - 1].list : root
        parent.appendChild(list)
        stack.push({ level, list })
      }
      const item = doc.createElement('li')
      item.innerHTML = paragraph.innerHTML
      stack[stack.length - 1].list.appendChild(item)
    }
    first.before(...root.childNodes)
    for (const paragraph of run) paragraph.remove()
  }
}

function codeLanguages(doc: Document): void {
  for (const pre of doc.querySelectorAll<HTMLElement>('pre')) {
    const code = pre.querySelector('code')
    const named = [pre, code].map((element) => /(?:^|\s)(?:language|lang)-([\w+#.-]{1,30})/.exec(element?.className ?? '')?.[1]).find(Boolean)
    if (named && !pre.dataset.language) pre.dataset.language = named
    const holder = code ?? pre
    const last = holder.lastChild
    if (last?.nodeType === Node.TEXT_NODE && last.textContent?.endsWith('\n')) last.textContent = last.textContent.slice(0, -1)
  }
}

/** Whether the HTML came from outside (the editor's own copy carries `data-pm-slice`). */
let fromOutside = false

export function cleanPastedHtml(html: string): string {
  fromOutside = !/data-pm-slice/.test(html)
  if (!fromOutside) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (/mso-list/i.test(html)) wordLists(doc)
  if (/<pre/i.test(html)) codeLanguages(doc)
  return doc.body.innerHTML
}

const BLOCKS = new Set(['heading', 'bullet_list', 'ordered_list', 'code_block', 'table', 'blockquote', 'hr'])

/** From outside, a first block of its own kind stays a block instead of running into the line it lands in. */
export function keepFirstBlock(slice: Slice): Slice {
  const outside = fromOutside
  fromOutside = false
  const first: ProseNode | null = slice.content.firstChild
  if (!outside || slice.openStart === 0 || !first || !BLOCKS.has(first.type.name)) return slice
  return new Slice(slice.content, 0, slice.openEnd)
}
