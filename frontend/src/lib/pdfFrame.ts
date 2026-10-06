/**
 * What the page and the PDF frame say to each other. The frame (`/pdfview.html`, `src/pdfview/main.ts`) has no
 * origin of its own and no network at all: the page fetches the PDF and the few files pdf.js asks for, and hands them
 * over. A PDF is code from someone else (fonts, forms, images in odd formats); whatever goes wrong in pdf.js stays in
 * a frame that reaches neither the session nor the vault.
 */
import type { Links } from '../api/client'

export type Colours = { ground: string; panel: string; text: string; muted: string; accent: string; line: string }

export type FrameTexts = { pages: string; contents: string; noContents: string; password: string; broken: string; page: string }

export type ToFrame =
  | { type: 'open'; data: ArrayBuffer; page: number; colours: Colours; texts: FrameTexts; sidebar: boolean; compact: boolean }
  | { type: 'go'; page: number }
  | { type: 'zoom'; to: 'in' | 'out' | 'width' }
  | { type: 'find'; query: string; previous: boolean; again: boolean }
  | { type: 'sidebar'; show: boolean }
  | { type: 'colours'; colours: Colours }
  | { type: 'data'; id: number; bytes: ArrayBuffer | null }

export type FromFrame =
  | { type: 'ready' }
  | { type: 'loaded'; pages: number }
  | { type: 'page'; page: number }
  | { type: 'scale'; percent: number }
  | { type: 'found'; current: number; total: number }
  | { type: 'link'; href: string }
  | { type: 'data'; id: number; kind: DataKind; name: string }
  | { type: 'failed'; reason: 'password' | 'broken' }
  /** Ctrl+F inside the frame: the page opens its find bar (the browser's own would search the frame only). */
  | { type: 'findKey' }

/** The kinds of file pdf.js may ask for, and the folder they lie in under `/pdfjs/`. */
export type DataKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'
export const DATA_FOLDERS: Record<DataKind, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }

/** A file name pdf.js may ask for: no path, nothing but letters, digits, dots, dashes and underscores. */
export function plainName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name) && !name.includes('..')
}

/** The page of a link or embed: `page=3` in `#page=3&height=400` (Obsidian's way); none is page 1. */
export function pageOf(section: string | undefined): number {
  const found = /(?:^|&)page=(\d{1,6})/.exec(section ?? '')
  return found ? Math.max(1, Number(found[1])) : 1
}

/** The height of an embed in pixels: `height=400`; none is the default. */
export function heightOf(section: string | undefined, fallback = 480): number {
  const found = /(?:^|&)height=(\d{2,4})/.exec(section ?? '')
  return found ? Math.min(2000, Math.max(120, Number(found[1]))) : fallback
}

/** Only what the web is: an address a click in a PDF may open, in a tab of its own. */
export function openable(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href)
}

/** The notes that link the PDF, each once, with the pages their links name. */
export function linkedIn(links: Links | null): { path: string; title: string; pages: number[]; whole: boolean }[] {
  const byNote = new Map<string, { path: string; title: string; pages: Set<number>; whole: boolean }>()
  for (const link of links?.backlinks ?? []) {
    const entry = byNote.get(link.path) ?? { path: link.path, title: link.title, pages: new Set<number>(), whole: false }
    const page = /(?:^|&)page=(\d{1,6})/.exec(link.subpath ?? '')
    if (page) entry.pages.add(Number(page[1]))
    else entry.whole = true
    byNote.set(link.path, entry)
  }
  return [...byNote.values()].map((entry) => ({ ...entry, pages: [...entry.pages].sort((a, b) => a - b) }))
}

/**
 * pdf.js's worker as a classic script. It comes inside this script, not from an address: a frame without an origin
 * may start no worker of the server, and Chrome starts no module worker in it at all (measured: a classic one from a
 * blob answers, a module one fails). pdf.js ships the worker as a module; its only module parts are the export at the
 * end and `import.meta.url` in two image decoders, both replaced here. Anything else of a module stops right here.
 */
export function classicWorker(source: string): string {
  const classic = source
    .replace(/export\s*\{\s*WorkerMessageHandler\s*\};?\s*(\/\/# sourceMappingURL=\S*)?\s*$/, '')
    .replaceAll('import.meta.url', 'self.location.href')
  if (/(^|[;}\s])export\s*\{|import\.meta|^\s*import\s/m.test(classic)) throw new Error('pdf.js worker is no longer a plain script')
  return classic
}
