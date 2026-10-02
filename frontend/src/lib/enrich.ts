/**
 * What the reading view draws after the page shows: formulas (KaTeX), Mermaid diagrams and the colours of code. The
 * Markdown renderer only marks them (`lib/markdown.ts`); each library loads the first time a note needs it, so a
 * note without them costs nothing. Until drawn, and if drawing fails, the text stays as it is: nothing is lost.
 *
 * Safety: KaTeX runs with `trust: false` (no \href, \url or HTML from a formula), Mermaid with `securityLevel:
 * 'strict'` (no click handlers, its own sanitizer); the code colours only wrap text in spans.
 */
import { useEffect, type RefObject } from 'react'

const DONE = 'data-drawn'

/**
 * KaTeX as the app uses it. maxExpand and maxSize bound what macros and sizes may grow to; a formula nested deeper
 * than MAX_FORMULA_DEPTH or longer than MAX_FORMULA stays its text: a reader's tab crashed at about 1,500 levels.
 */
const KATEX = { throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxExpand: 500, maxSize: 50 } as const
const MAX_FORMULA = 20_000
const MAX_FORMULA_DEPTH = 100

/** Whether KaTeX may draw it: not too long, braces not nested too deep. */
export function drawable(tex: string): boolean {
  if (tex.length > MAX_FORMULA) return false
  let depth = 0
  for (const char of tex) {
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth > MAX_FORMULA_DEPTH) return false
  }
  return true
}

/** A formula as HTML (KaTeX); also the editor's preview of a formula block. */
export async function mathHtml(tex: string, display: boolean): Promise<string> {
  const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')])
  if (!drawable(tex)) throw new Error('formula too deep')
  return katex.renderToString(tex, { ...KATEX, displayMode: display })
}

async function drawMath(elements: HTMLElement[]): Promise<void> {
  const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')])
  for (const element of elements) {
    const tex = element.textContent ?? ''
    if (!drawable(tex)) continue
    try {
      katex.render(tex, element, { ...KATEX, displayMode: element.dataset.display === 'true' })
    } catch {
      element.textContent = tex
    }
  }
}

let mermaidCount = 0

/** A Mermaid diagram as SVG, drawn in the light or dark of the app; also the editor's preview of the block. */
export async function mermaidSvg(source: string): Promise<string> {
  const { default: mermaid } = await import('mermaid')
  const dark = document.documentElement.getAttribute('data-theme') !== 'light'
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'inherit' })
  const { svg } = await mermaid.render(`nn-mermaid-${++mermaidCount}`, source)
  return svg
}

async function drawMermaid(elements: HTMLElement[]): Promise<void> {
  for (const element of elements) {
    const source = element.textContent ?? ''
    try {
      element.innerHTML = await mermaidSvg(source)
      element.dataset.source = source
    } catch {
      // A diagram Mermaid cannot read stays its text, marked so the reader sees why.
      element.textContent = source
      element.classList.add('nn-mermaid-failed')
    }
  }
}

/** `language-js`, `language-python` …: the name after "language-", as Obsidian writes it after the fence. */
function languageOf(element: HTMLElement): string | null {
  const found = [...element.classList].find((name) => name.startsWith('language-'))
  return found ? found.slice('language-'.length) : null
}

async function drawCode(elements: HTMLElement[]): Promise<void> {
  const [{ languages }, { highlightCode, classHighlighter }] = await Promise.all([import('@codemirror/language-data'), import('@lezer/highlight')])
  const { LanguageDescription } = await import('@codemirror/language')
  for (const element of elements) {
    const name = languageOf(element)
    const found = name ? LanguageDescription.matchLanguageName(languages, name, true) : null
    if (!found) continue
    try {
      const support = await found.load()
      const text = element.textContent ?? ''
      const tree = support.language.parser.parse(text)
      const out = document.createDocumentFragment()
      highlightCode(
        text,
        tree,
        classHighlighter,
        (piece, classes) => {
          if (!classes) return void out.append(piece)
          const span = document.createElement('span')
          span.className = classes
          span.textContent = piece
          out.append(span)
        },
        () => out.append('\n'),
      )
      element.replaceChildren(out)
    } catch {
      // Left plain.
    }
  }
}

/** Draws what `root` holds and was not drawn yet. */
export async function enrich(root: HTMLElement | null): Promise<void> {
  if (!root) return
  const take = (selector: string) => {
    const found = [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => !element.hasAttribute(DONE))
    found.forEach((element) => element.setAttribute(DONE, ''))
    return found
  }
  const math = take('.nn-math')
  const diagrams = take('.nn-mermaid')
  const code = take('pre > code[class*="language-"]')
  await Promise.all([
    math.length ? drawMath(math).catch(() => {}) : null,
    diagrams.length ? drawMermaid(diagrams).catch(() => {}) : null,
    code.length ? drawCode(code).catch(() => {}) : null,
  ])
}

/** Draws after each new `html` in the element behind `ref` (the reading view, an embed, a public page). */
export function useEnrich(ref: RefObject<HTMLElement | null>, html: string): void {
  useEffect(() => {
    void enrich(ref.current)
  }, [ref, html])
}
