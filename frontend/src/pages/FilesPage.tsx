/**
 * The files behind the notes: how far the index is, the attachments with how often each is used, the trash, and
 * bringing in an Obsidian vault.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError, vaultApi, type Attachment, type Finding, type IndexState, type Report, type TrashEntry, type Usage } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Symbol, type SymbolName } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { fileKind, formatSize } from '../lib/files'
import { fileRoute, formatDate } from '../lib/markdown'
import { useAuth } from '../state/auth'
import { useStore } from '../state/store'

export function FilesPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  return (
    <main className="nn-scroll flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('files.title')}</h1>
          <p className="mt-1 text-sm text-mist-500">{t('files.intro')}</p>
        </div>
        {/* The index spans every space: the operator's. */}
        {me?.role === 'operator' && <IndexCard />}
        <AttachmentsCard />
        <TrashCard />
        <ImportCard />
      </div>
    </main>
  )
}

function Card({ symbol, title, text, children }: { symbol: SymbolName; title: string; text: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <Symbol name={symbol} className="h-4 w-4 text-accent-400" />
        {title}
      </h2>
      <p className="mt-1 mb-4 text-sm text-mist-500">{text}</p>
      {children}
    </section>
  )
}

function IndexCard() {
  const { t } = useTranslation()
  const { reload } = useStore()
  const [state, setState] = useState<IndexState | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => vaultApi.index().then(setState).catch(() => undefined), [])
  useEffect(() => void load(), [load])

  const [failed, setFailed] = useState<string | null>(null)

  const rescan = async (confirmDeletions = false) => {
    setBusy(true)
    setFailed(null)
    try {
      await vaultApi.rescan(confirmDeletions)
      await Promise.all([load(), reload()])
    } catch (error) {
      // Another pass runs already (the first one after the start, the watcher's): said, and the state shown.
      setFailed(error instanceof ApiError ? error.code : 'internal_error')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const last = state?.last
  return (
    <Card symbol="refresh" title={t('files.index.title')} text={t('files.index.text')}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {state?.running ? (
          <span className="text-mist-300">{t('files.index.running', { done: state.done, total: state.total })}</span>
        ) : last ? (
          <span className="text-mist-300">
            {t('files.index.last', { when: formatDate(state!.last_at!), files: last.files, seconds: last.seconds })}
          </span>
        ) : (
          <span className="text-mist-500">{t('files.index.never')}</span>
        )}
        <button type="button" onClick={() => void rescan()} disabled={busy || !!state?.running} className="ml-auto rounded-full border border-ink-700 px-3 py-1 text-mist-300 hover:bg-ink-850 disabled:opacity-40">
          {t('files.index.rescan')}
        </button>
      </div>
      {failed && (
        <p className="mt-2 text-sm text-warn-500" role="alert">
          {errorText(failed)}
        </p>
      )}
      {state && Object.keys(state.held_back).length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-warn-500/30 bg-warn-500/10 px-4 py-2.5 text-sm text-warn-500" role="alert">
          <span className="flex-1">{t('files.index.heldBack', { spaces: Object.keys(state.held_back).join(', ') })}</span>
          <button type="button" onClick={() => void rescan(true)} disabled={busy} className="rounded-full border border-warn-500/40 px-3 py-1 text-xs hover:bg-warn-500/10 disabled:opacity-40">
            {t('files.index.confirm')}
          </button>
        </div>
      )}
    </Card>
  )
}

function TrashCard() {
  const { t } = useTranslation()
  const { reload } = useStore()
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [purging, setPurging] = useState<TrashEntry | null>(null)

  const load = useCallback(() => vaultApi.trash().then(setEntries).catch((error) => setProblem(error instanceof ApiError ? error.code : 'internal_error')), [])
  useEffect(() => void load(), [load])

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action()
      setProblem(null)
      await Promise.all([load(), reload()])
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  return (
    <Card symbol="trash" title={t('files.trash.title')} text={t('files.trash.text')}>
      {entries?.length === 0 && <p className="text-sm text-mist-500">{t('files.trash.empty')}</p>}
      {!!entries?.length && (
        <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{entry.path}</span>
                <span className="block text-xs text-mist-500">
                  {entry.how === 'external' ? t('files.trash.external', { when: formatDate(entry.deleted_at) }) : t('files.trash.deleted', { when: formatDate(entry.deleted_at), by: entry.by ?? '' })}
                  {entry.files > 1 && ` · ${t('files.trash.files', { count: entry.files })}`}
                </span>
              </span>
              <button type="button" onClick={() => void act(() => vaultApi.restoreTrash(entry.id))} className="rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-on-accent hover:bg-accent-400">
                {t('files.trash.restore')}
              </button>
              <button
                type="button"
                onClick={() => setPurging(entry)}
                className="rounded-full border border-ink-700 px-3 py-1 text-xs text-bad-500 hover:bg-ink-850"
              >
                {t('files.trash.purge')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="mt-2 text-sm text-bad-500">{errorText(problem)}</p>}
      <ConfirmDialog
        open={purging !== null}
        title={t('files.trash.purgeTitle', { path: purging?.path ?? '' })}
        confirm={t('files.trash.purge')}
        danger
        onCancel={() => setPurging(null)}
        onConfirm={() => {
          const entry = purging
          setPurging(null)
          if (entry) void act(() => vaultApi.purgeTrash(entry.id))
        }}
      >
        {t('files.trash.purgeText')}
      </ConfirmDialog>
    </Card>
  )
}

/** The files in a space that are not notes: size, how many notes use each, the space the account has used. */
function AttachmentsCard() {
  const { t, i18n } = useTranslation()
  const { spaces } = useStore()
  const [space, setSpace] = useState('')
  const [unused, setUnused] = useState(false)
  const [list, setList] = useState<{ total: number; items: Attachment[] } | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const shown = space || spaces[0]?.name || ''

  useEffect(() => {
    vaultApi.usage().then(setUsage).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!shown) return
    let live = true
    setList(null)
    vaultApi
      .attachments(shown, unused)
      .then((found) => {
        if (!live) return
        setList(found)
        setProblem(null)
      })
      .catch((error) => live && setProblem(error instanceof ApiError ? error.code : 'internal_error'))
    return () => {
      live = false
    }
  }, [shown, unused])

  const more = async () => {
    if (!list) return
    try {
      const next = await vaultApi.attachments(shown, unused, list.items.length)
      setList({ total: next.total, items: [...list.items, ...next.items] })
      setProblem(null)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  const size = (bytes: number) => formatSize(bytes, i18n.language)
  return (
    <Card symbol="clip" title={t('files.attachments.title')} text={t('files.attachments.text', { folder: usage?.folder ?? '' })}>
      {usage && (
        <p className="mb-3 text-sm text-mist-400">
          {usage.quota
            ? t('files.attachments.usedOf', { used: size(usage.used), quota: size(usage.quota) })
            : t('files.attachments.used', { used: size(usage.used) })}
          {' · '}
          {t('files.attachments.perFile', { size: size(usage.per_file) })}
          {' · '}
          {usage.strip_location ? t('files.attachments.stripOn') : t('files.attachments.stripOff')}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-mist-400">
          {t('files.attachments.space')}
          <select value={shown} onChange={(event) => setSpace(event.target.value)} className="h-8 rounded-lg border border-ink-700 bg-ink-850 px-2 text-mist-100 outline-none focus:border-accent-500">
            {spaces.map((item) => (
              <option key={item.id} value={item.name}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-mist-400">
          <input type="checkbox" checked={unused} onChange={(event) => setUnused(event.target.checked)} className="accent-accent-500" />
          {t('files.attachments.onlyUnused')}
        </label>
        {list && <span className="ml-auto text-mist-500">{t('files.attachments.count', { count: list.total })}</span>}
      </div>
      {list?.items.length === 0 && <p className="text-sm text-mist-500">{unused ? t('files.attachments.noneUnused') : t('files.attachments.none')}</p>}
      {!!list?.items.length && (
        <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
          {list.items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <Symbol name={fileKind(item.path) === 'image' ? 'image' : fileKind(item.path) === 'pdf' ? 'pdf' : 'file'} className="h-4 w-4 shrink-0 text-mist-500" />
              <Link to={fileRoute(item.path)} className="min-w-0 flex-1 truncate text-mist-200 hover:text-accent-400">
                {item.path.slice(shown.length + 1)}
              </Link>
              <span className="shrink-0 text-xs text-mist-500 tabular-nums">{size(item.size)}</span>
              <span className={'w-24 shrink-0 text-right text-xs ' + (item.uses ? 'text-mist-500' : 'text-warn-500')}>
                {item.uses ? t('files.attachments.uses', { count: item.uses }) : t('files.attachments.unused')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {list && list.items.length < list.total && (
        <button type="button" onClick={() => void more()} className="mt-3 rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
          {t('files.attachments.more')}
        </button>
      )}
      {problem && <p className="mt-2 text-sm text-bad-500">{errorText(problem)}</p>}
    </Card>
  )
}

function ImportCard() {
  const { t } = useTranslation()
  const { reload } = useStore()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const start = async () => {
    if (!file || !name.trim()) return
    setBusy(true)
    setProblem(null)
    try {
      setReport(await vaultApi.importVault(file, name.trim()))
      await reload()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card symbol="upload" title={t('files.import.title')} text={t('files.import.text')}>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
      >
        <input
          type="file"
          accept=".zip,application/zip"
          aria-label={t('files.import.file')}
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null
            setFile(chosen)
            if (chosen && !name) setName(chosen.name.replace(/\.zip$/i, ''))
          }}
          className="text-sm text-mist-400 file:mr-3 file:rounded-full file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-mist-200"
        />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('files.import.name')}
          aria-label={t('files.import.name')}
          className="h-9 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-850 px-3 text-sm outline-none focus:border-accent-500"
        />
        <button type="submit" disabled={!file || !name.trim() || busy} className="h-9 rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40">
          {busy ? t('files.import.busy') : t('files.import.start')}
        </button>
      </form>
      {problem && <p className="mt-2 text-sm text-bad-500">{errorText(problem)}</p>}
      {report && <ReportView report={report} />}
    </Card>
  )
}

function FindingRow({ label, finding }: { label: string; finding: Finding }) {
  if (!finding.count) return null
  return (
    <details className="rounded-lg px-2 py-1.5 hover:bg-ink-850">
      <summary className="cursor-pointer text-sm text-mist-300">
        {label} <span className="text-mist-500 tabular-nums">· {finding.count}</span>
      </summary>
      <ul className="mt-1 space-y-0.5 pl-4 font-mono text-[11px] text-mist-500">
        {finding.examples.map((example) => (
          <li key={example} className="truncate">{example}</li>
        ))}
      </ul>
    </details>
  )
}

/** What the import found. Plugin syntax is kept exactly as it is and shown as code, never run. */
export function ReportView({ report }: { report: Report }) {
  const { t } = useTranslation()
  return (
    <div className="mt-4 rounded-xl border border-ink-700 p-4 text-sm">
      <p className="font-medium">
        {t('files.report.summary', { space: report.space, notes: report.notes, files: report.other_files, links: report.links })}
      </p>
      {report.community_plugins.length > 0 && (
        <p className="mt-1 text-xs text-mist-500">{t('files.report.plugins', { list: report.community_plugins.join(', ') })}</p>
      )}
      <div className="mt-3 space-y-0.5">
        {Object.entries(report.plugins).map(([label, finding]) => (
          <FindingRow key={label} label={t('files.report.pluginSyntax', { kind: label })} finding={finding} />
        ))}
        <FindingRow label={t('files.report.unresolved')} finding={report.unresolved_links} />
        <FindingRow label={t('files.report.frontMatter')} finding={report.front_matter_errors} />
        <FindingRow label={t('files.report.notUtf8')} finding={report.not_utf8} />
        <FindingRow label={t('files.report.tooLarge')} finding={report.too_large} />
        <FindingRow label={t('files.report.unportable')} finding={report.unportable_names} />
        <FindingRow label={t('files.report.caseTwins')} finding={report.case_collisions} />
        <FindingRow label={t('files.report.renamed')} finding={report.renamed_on_import} />
      </div>
    </div>
  )
}
