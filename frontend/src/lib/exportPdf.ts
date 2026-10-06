/**
 * Printing a note and saving it as PDF, for a note or a whole folder. The server sets the PDF (Typst); the dialog
 * shows its pages before. The dialog lives in the app's frame (`ExportHost`), asked for by an event like the other
 * dialogs of the menus. What a person chose last is kept in this browser, the paper size for example.
 */
import { api } from '../api/client'

export type ExportTarget = { path: string; folder?: undefined } | { folder: string; path?: undefined }
/** Which button the dialog leads with: printing or the file. */
export type ExportMode = 'print' | 'pdf'

export type ExportOptions = {
  paper: 'a4' | 'letter'
  landscape: boolean
  properties: boolean
  embeds: boolean
  links: 'footnote' | 'text'
  header: boolean
  footer: boolean
  font: 'app' | 'serif'
  contents: boolean
  new_page: boolean
}

export const DEFAULT_OPTIONS: ExportOptions = {
  paper: 'a4', landscape: false, properties: true, embeds: true, links: 'footnote', header: true, footer: true,
  font: 'app', contents: true, new_page: true,
}

const STORED = 'nexlore.exportOptions'

/** The options chosen last in this browser, each checked; anything odd falls back to the default. */
export function storedOptions(): ExportOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(STORED) ?? '{}') as Record<string, unknown>
    const out = { ...DEFAULT_OPTIONS } as Record<string, unknown>
    for (const [key, fallback] of Object.entries(DEFAULT_OPTIONS)) {
      const value = raw[key]
      if (typeof fallback === 'boolean' && typeof value === 'boolean') out[key] = value
      if (key === 'paper' && (value === 'a4' || value === 'letter')) out[key] = value
      if (key === 'links' && (value === 'footnote' || value === 'text')) out[key] = value
      if (key === 'font' && (value === 'app' || value === 'serif')) out[key] = value
    }
    return out as ExportOptions
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
}

export function storeOptions(options: ExportOptions): void {
  try {
    localStorage.setItem(STORED, JSON.stringify(options))
  } catch {
    // A browser without storage starts from the defaults next time.
  }
}

type Body = ExportTarget & { only?: string[]; options: ExportOptions & { language: 'de' | 'en' } }

export const exportApi = {
  pdf: (body: Body) => api<Blob>('/api/export/pdf', { method: 'POST', body, blob: true }),
  preview: (body: Body) => api<{ pages: string[]; more_notes: number }>('/api/export/preview', { method: 'POST', body }),
  folderNotes: (folder: string) => api<{ notes: string[] }>('/api/export/notes', { query: { folder } }),
}

export const EXPORT_EVENT = 'nexlore:export'
export type ExportAsk = { target: ExportTarget; mode: ExportMode }

export function askExport(target: ExportTarget, mode: ExportMode): void {
  window.dispatchEvent(new CustomEvent<ExportAsk>(EXPORT_EVENT, { detail: { target, mode } }))
}

/** The file name of the download: the note's or the folder's name. */
export function fileName(target: ExportTarget): string {
  const path = target.path ?? target.folder ?? 'note'
  const name = path.split('/').pop() ?? 'note'
  return name.replace(/\.md$/i, '') + '.pdf'
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * The PDF to the printer: loaded into a hidden frame whose print dialog opens. Where a browser cannot print a PDF
 * from a frame (Safari on the iPhone, for example), the PDF opens in a tab of its own, and that tab prints it.
 */
export function print(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  frame.setAttribute('aria-hidden', 'true')
  frame.dataset.testid = 'print-frame'
  const fallback = () => {
    window.open(url, '_blank', 'noopener')
    frame.remove()
  }
  frame.onload = () => {
    try {
      const view = frame.contentWindow
      if (!view) return fallback()
      view.focus()
      view.print()
    } catch {
      fallback()
    }
    setTimeout(() => {
      frame.remove()
      URL.revokeObjectURL(url)
    }, 120_000)
  }
  frame.src = url
  document.body.appendChild(frame)
}
