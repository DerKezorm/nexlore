/**
 * Printing a note or saving it as PDF, and a whole folder as one PDF. Left the pages as the server sets them (every
 * choice on the right shows at once), right the choices. The paper is always light; comments, search marks and
 * Lore's window never go on it. Lives in the app's frame (`ExportHost`): the menus ask for it by an event.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '../api/client'
import { errorText } from '../lib/errors'
import {
  download, EXPORT_EVENT, exportApi, fileName, print, storedOptions, storeOptions,
  type ExportAsk, type ExportMode, type ExportOptions, type ExportTarget,
} from '../lib/exportPdf'
import { Symbol } from './Symbol'

const nameOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '')

/** Waits this long after the last change of a choice before the preview is set again. */
const PREVIEW_PAUSE_MS = 350

export function ExportHost() {
  const [asked, setAsked] = useState<ExportAsk | null>(null)
  useEffect(() => {
    const take = (event: Event) => setAsked((event as CustomEvent<ExportAsk>).detail)
    window.addEventListener(EXPORT_EVENT, take)
    return () => window.removeEventListener(EXPORT_EVENT, take)
  }, [])
  if (!asked) return null
  return <ExportDialog key={JSON.stringify(asked)} target={asked.target} mode={asked.mode} onClose={() => setAsked(null)} />
}

function Choice<T extends string>({ value, options, onChange, label }: {
  value: T; options: [T, string][]; onChange: (value: T) => void; label: string
}) {
  return (
    <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-ink-700 p-0.5" role="radiogroup" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          className={`rounded-md px-2.5 py-1 text-xs ${value === key ? 'bg-accent-500/15 font-semibold text-accent-300' : 'text-mist-300 hover:bg-ink-850'}`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

function Tick({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1 text-sm text-mist-200">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 accent-accent-500" />
      <span>
        {label}
        {hint && <span className="block text-xs text-mist-500">{hint}</span>}
      </span>
    </label>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-mist-500">{title}</h3>
      {children}
    </div>
  )
}

export function ExportDialog({ target, mode, onClose }: { target: ExportTarget; mode: ExportMode; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const folder = target.folder !== undefined
  const [options, setOptions] = useState<ExportOptions>(storedOptions)
  const [notes, setNotes] = useState<string[] | null>(folder ? null : [])
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [pages, setPages] = useState<string[]>([])
  const [moreNotes, setMoreNotes] = useState(0)
  const [setting, setSetting] = useState(true)
  const [busy, setBusy] = useState<ExportMode | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const language: 'de' | 'en' = i18n.language.startsWith('de') ? 'de' : 'en'

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  useEffect(() => {
    if (!folder) return
    let live = true
    exportApi.folderNotes(target.folder!).then(
      (found) => {
        if (!live) return
        setNotes(found.notes)
        setTicked(new Set(found.notes))
      },
      (error) => live && setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error')),
    )
    return () => {
      live = false
    }
  }, [folder, target.folder])

  const only = folder && notes ? notes.filter((path) => ticked.has(path)) : undefined
  const body = { ...target, only, options: { ...options, language } }
  const bodyKey = JSON.stringify(body)

  // The preview follows every choice, set anew a moment after the last one; an older answer never overwrites.
  useEffect(() => {
    if (folder && (!notes || only?.length === 0)) {
      setPages([])
      setSetting(false)
      return
    }
    let live = true
    setSetting(true)
    const timer = window.setTimeout(() => {
      exportApi.preview(JSON.parse(bodyKey)).then(
        (answer) => {
          if (!live) return
          setPages(answer.pages)
          setMoreNotes(answer.more_notes)
          setProblem(null)
          setSetting(false)
        },
        (error) => {
          if (!live) return
          setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
          setSetting(false)
        },
      )
    }, PREVIEW_PAUSE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bodyKey stands for everything the preview depends on
  }, [bodyKey])

  const change = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
    const next = { ...options, [key]: value }
    setOptions(next)
    storeOptions(next)
  }

  const run = async (what: ExportMode) => {
    setBusy(what)
    setProblem(null)
    try {
      const blob = await exportApi.pdf(body)
      if (what === 'pdf') download(blob, fileName(target))
      else print(blob)
      onClose()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
      setBusy(null)
    }
  }

  const title = folder ? t('export.folderTitle') : mode === 'pdf' ? t('export.pdfTitle') : t('export.printTitle')
  const subject = nameOf(target.path ?? target.folder ?? '')
  const nothing = folder && notes !== null && (only?.length ?? 0) === 0
  const lead: ExportMode = folder ? 'pdf' : mode

  const toggle = (path: string) => {
    const next = new Set(ticked)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setTicked(next)
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onClick={(event) => event.target === dialog.current && !busy && onClose()}
      className="m-auto h-[min(46rem,calc(100dvh-2rem))] w-[min(68rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim max-md:h-dvh max-md:max-h-none max-md:w-screen max-md:max-w-none max-md:rounded-none"
      data-testid="export-dialog"
    >
      <div className="grid h-full grid-cols-[minmax(0,1fr)_23rem] max-md:grid-cols-1 max-md:grid-rows-[16rem_minmax(0,1fr)]">
        <div className="nn-scroll relative flex flex-col items-center gap-4 overflow-y-auto bg-ink-950 p-5 max-md:p-3" aria-label={t('export.preview')} data-testid="export-preview">
          {pages.map((page, at) => (
            <img
              key={at}
              src={`data:image/png;base64,${page}`}
              alt={t('export.page', { page: at + 1 })}
              className="w-full max-w-[34rem] bg-white shadow-lg"
              data-testid="export-page"
            />
          ))}
          {moreNotes > 0 && <p className="text-xs text-mist-500">{t('export.moreNotes', { count: moreNotes })}</p>}
          {nothing && <p className="m-auto text-sm text-mist-500">{t('export.nothingTicked')}</p>}
          {setting && (
            <div className="absolute inset-0 grid place-items-center bg-ink-950/40" data-testid="export-setting">
              <span className="rounded-full bg-ink-900 px-3 py-1 text-xs text-mist-300 shadow">{t('export.setting')}</span>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-col border-l border-ink-800 max-md:border-l-0 max-md:border-t">
          <div className="border-b border-ink-800 px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold text-mist-100">{title}</h2>
            <p className="mt-0.5 truncate text-xs text-mist-500">{subject}</p>
          </div>
          <div className="nn-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-4">
            {folder && (
              <Group title={t('export.which')}>
                <div className="nn-scroll max-h-48 overflow-y-auto rounded-lg border border-ink-800" data-testid="export-notes">
                  {(notes ?? []).map((path) => (
                    <label key={path} className="flex cursor-pointer items-center gap-2 border-b border-ink-800 px-2.5 py-1.5 text-sm last:border-b-0">
                      <input type="checkbox" checked={ticked.has(path)} onChange={() => toggle(path)} className="accent-accent-500" />
                      <span className="min-w-0 flex-1 truncate">{nameOf(path)}</span>
                      <span className="shrink-0 truncate text-[11px] text-mist-600">{path.split('/').slice(target.folder!.split('/').length, -1).join(' › ')}</span>
                    </label>
                  ))}
                  {notes === null && <p className="px-2.5 py-2 text-xs text-mist-500">{t('common.loading')}</p>}
                </div>
                <p className="mt-1.5 text-xs text-mist-500">{t('export.ticked', { count: only?.length ?? 0, all: notes?.length ?? 0 })}</p>
                <Tick checked={options.contents} onChange={(value) => change('contents', value)} label={t('export.contents')} hint={t('export.contentsHint')} />
                <Tick checked={options.new_page} onChange={(value) => change('new_page', value)} label={t('export.newPage')} />
              </Group>
            )}
            <Group title={t('export.paper')}>
              <div className="flex flex-wrap gap-2">
                <Choice label={t('export.paper')} value={options.paper} onChange={(value) => change('paper', value)} options={[['a4', 'A4'], ['letter', 'Letter']]} />
                <Choice
                  label={t('export.orientation')}
                  value={options.landscape ? 'landscape' : 'portrait'}
                  onChange={(value) => change('landscape', value === 'landscape')}
                  options={[['portrait', t('export.portrait')], ['landscape', t('export.landscape')]]}
                />
              </div>
            </Group>
            <Group title={t('export.content')}>
              <Tick checked={options.properties} onChange={(value) => change('properties', value)} label={t('export.properties')} />
              <Tick checked={options.embeds} onChange={(value) => change('embeds', value)} label={t('export.embeds')} hint={t('export.embedsHint')} />
            </Group>
            <Group title={t('export.links')}>
              <Choice label={t('export.links')} value={options.links} onChange={(value) => change('links', value)} options={[['footnote', t('export.linksFootnote')], ['text', t('export.linksText')]]} />
              <p className="mt-1.5 text-xs text-mist-500">{t('export.linksHint')}</p>
            </Group>
            <Group title={t('export.headFoot')}>
              <Tick checked={options.header} onChange={(value) => change('header', value)} label={t('export.header')} />
              <Tick checked={options.footer} onChange={(value) => change('footer', value)} label={t('export.footer')} />
            </Group>
            <Group title={t('export.font')}>
              <Choice label={t('export.font')} value={options.font} onChange={(value) => change('font', value)} options={[['app', t('export.fontApp')], ['serif', t('export.fontSerif')]]} />
            </Group>
            <p className="mt-4 text-xs text-mist-500">{t('export.alwaysLight')}</p>
            {problem && <p className="mt-3 text-sm text-bad-400" role="alert">{problem}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-ink-800 px-5 py-3">
            <button type="button" disabled={!!busy} onClick={onClose} className="rounded-full px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={!!busy || nothing}
              onClick={() => void run('pdf')}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm disabled:opacity-50 ${lead === 'pdf' ? 'bg-accent-500 font-semibold text-on-accent hover:bg-accent-400' : 'border border-ink-700 text-mist-200 hover:bg-ink-850'}`}
            >
              <Symbol name="download" className="h-4 w-4" />
              {busy === 'pdf' ? t('export.working') : t('export.savePdf')}
            </button>
            {!folder && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void run('print')}
                className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm disabled:opacity-50 ${lead === 'print' ? 'bg-accent-500 font-semibold text-on-accent hover:bg-accent-400' : 'border border-ink-700 text-mist-200 hover:bg-ink-850'}`}
              >
                <Symbol name="print" className="h-4 w-4" />
                {busy === 'print' ? t('export.working') : t('export.print')}
              </button>
            )}
          </div>
        </div>
      </div>
    </dialog>
  )
}
