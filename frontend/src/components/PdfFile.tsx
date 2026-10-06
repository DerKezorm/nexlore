/**
 * The page of a PDF: the reader over the whole width, and on the right the notes that link the PDF (with the pages
 * they link), where it lies, and a note to write about it. `#page=3` in the address opens that page; turning pages
 * keeps the address up to date, so a reload or a copied address comes back to the same page.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { ApiError, vaultApi, type Links } from '../api/client'
import { errorText } from '../lib/errors'
import { isCanvasPath } from '../lib/files'
import { fileRoute } from '../lib/markdown'
import { linkedIn, pageOf } from '../lib/pdfFrame'
import { folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'
import { ConfirmDialog } from './ConfirmDialog'
import { PdfView } from './PdfView'
import { Sidebar } from './Sidebar'
import { Symbol } from './Symbol'

const PANEL = 'nexlore.pdfPanel'

function panelWanted(): boolean {
  try {
    return localStorage.getItem(PANEL) !== 'off'
  } catch {
    return true
  }
}

export function PdfFile({ path }: { path: string }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { reload } = useStore()
  const [links, setLinks] = useState<Links | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [panel, setPanel] = useState(panelWanted)
  const [making, setMaking] = useState(false)
  const page = pageOf(location.hash.replace(/^#/, ''))
  const name = path.slice(path.lastIndexOf('/') + 1)
  const notes = useMemo(() => linkedIn(links), [links])
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })

  useEffect(() => {
    let live = true
    vaultApi.links(path).then(
      (found) => live && setLinks(found),
      (error) => live && setProblem(error instanceof ApiError ? error.code : 'internal_error'),
    )
    return () => {
      live = false
    }
  }, [path])

  const togglePanel = () => {
    const next = !panel
    setPanel(next)
    try {
      localStorage.setItem(PANEL, next ? 'on' : 'off')
    } catch {
      // Kept only where the browser keeps it.
    }
  }

  // Turning pages writes the page into the address, without a new step back in the history.
  const turned = (next: number) => {
    const wanted = next > 1 ? `#page=${next}` : ''
    if (window.location.hash !== wanted) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + wanted)
  }

  const makeNote = async () => {
    setMaking(true)
    try {
      const stem = name.replace(/\.pdf$/i, '')
      const note = await vaultApi.create(folderOf(path), stem, `[[${name}]]\n\n`)
      await reload()
      navigate(noteUrl(note.path) + `?right=${encodeURIComponent(path)}&edit=1`)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
      setMaking(false)
    }
  }

  const remove = async () => {
    setDeleting(false)
    try {
      await vaultApi.remove(path)
      await reload()
      navigate(notes[0] ? noteUrl(notes[0].path) : '/files')
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  return (
    <>
      <Sidebar activeNote={path} onNote={(next) => navigate(noteUrl(next))} />
      <main className="flex min-w-0 flex-1" data-testid="pdf-file">
        <div className="min-w-0 flex-1">
          <PdfView
            key={path}
            path={path}
            page={page}
            onPage={turned}
            tools={
              <button
                type="button"
                onClick={togglePanel}
                aria-pressed={panel}
                aria-label={t('pdf.panel')}
                title={t('pdf.panel')}
                className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-lg text-mist-300 hover:bg-ink-850 hover:text-accent-300 max-lg:hidden"
              >
                <Symbol name="panel" className="h-4 w-4" />
              </button>
            }
          />
        </div>
        {panel && (
          <aside className="nn-scroll w-72 shrink-0 overflow-y-auto border-l border-ink-800 bg-ink-900 p-4 text-sm max-lg:hidden" data-testid="pdf-panel">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mist-500">{t('pdf.linkedIn')}</h2>
            {links && notes.length === 0 && <p className="text-mist-500">{t('pdf.notLinked')}</p>}
            <ul className="space-y-2">
              {notes.map((note) => (
                <li key={note.path}>
                  <button
                    type="button"
                    onClick={() => navigate(isCanvasPath(note.path) ? fileRoute(note.path) : noteUrl(note.path) + `?right=${encodeURIComponent(path)}`)}
                    className="block w-full rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2 text-left hover:border-accent-500/40"
                  >
                    <span className="block font-medium text-mist-200">{note.title}</span>
                    <span className="block text-xs text-mist-500">
                      {[
                        ...(note.pages.length ? [t('pdf.onPages', { pages: list.format(note.pages.map(String)) })] : []),
                        ...(note.whole ? [t('pdf.wholePdf')] : []),
                      ].join(', ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <h2 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wider text-mist-500">{t('pdf.file')}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-mist-500">{t('pdf.where')}</dt>
              <dd className="break-all text-mist-300">{folderOf(path)}</dd>
            </dl>
            <h2 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wider text-mist-500">{t('pdf.newNote')}</h2>
            <button
              type="button"
              onClick={() => void makeNote()}
              disabled={making}
              className="w-full rounded-full border border-accent-500/40 px-3 py-1.5 text-sm text-accent-300 hover:bg-accent-500/10 disabled:opacity-50"
            >
              + {t('pdf.newNote')}
            </button>
            <p className="mt-1.5 text-xs text-mist-500">{t('pdf.newNoteHint')}</p>
            {problem && <p className="mt-4 text-sm text-bad-400" role="alert">{problem === 'not_found' ? t('file.notFound') : errorText(problem)}</p>}
            <button type="button" onClick={() => setDeleting(true)} disabled={!links} className="mt-8 text-xs text-bad-500 hover:underline disabled:opacity-40">
              {t('file.delete')}
            </button>
          </aside>
        )}
      </main>
      <ConfirmDialog
        open={deleting}
        title={t('file.deleteTitle', { name })}
        confirm={t('file.deleteDo')}
        onCancel={() => setDeleting(false)}
        onConfirm={() => void remove()}
      >
        {notes.length > 0 ? t('file.deleteUsed', { count: notes.length }) : t('file.deleteText')}
      </ConfirmDialog>
    </>
  )
}
