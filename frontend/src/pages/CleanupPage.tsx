/**
 * Cleaning up a space, a tab under Files: the notes no link leads to or from, and the links that lead nowhere. A
 * lonely note shows where other notes name it without a link (and links it from there); a link to nothing makes its
 * note beside the one it stands in, the way a click on it would.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ApiError, mentionsApi, vaultApi, type Cleanup } from '../api/client'
import { Symbol } from '../components/Symbol'
import { Unlinked } from '../components/Unlinked'
import { errorText } from '../lib/errors'
import { isFileTarget } from '../lib/files'
import { linkName, linkedSpace } from '../lib/links'
import { folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'
import { FilesTabs } from './FilesPage'

const SPACE_KEY = 'nexlore.cleanupSpace'

function rememberedSpace(): string {
  try {
    return localStorage.getItem(SPACE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function CleanupPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { spaces, reload } = useStore()
  const [chosen, setChosen] = useState(rememberedSpace)
  const space = spaces.some((item) => item.name === chosen) ? chosen : (spaces[0]?.name ?? '')
  const [found, setFound] = useState<(Cleanup & { space: string }) | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [ask, setAsk] = useState(0)
  const [mentionsOf, setMentionsOf] = useState<string | null>(null)
  const writable = spaces.find((item) => item.name === space)?.role !== 'read'

  useEffect(() => {
    if (!space) return
    let alive = true
    setProblem(null)
    mentionsApi.cleanup(space).then(
      (answer) => alive && setFound({ ...answer, space }),
      (error) => alive && setProblem(error instanceof ApiError ? error.code : 'internal_error'),
    )
    return () => {
      alive = false
    }
  }, [space, ask])

  const choose = (name: string) => {
    setChosen(name)
    setMentionsOf(null)
    try {
      localStorage.setItem(SPACE_KEY, name)
    } catch {
      /* kept for this visit only */
    }
  }

  /**
   * The note a link to nothing asks for, where a click on the link makes it: beside the note it stands in, or in the
   * other space the link names; opened for writing.
   */
  const make = async (source: string, target: string) => {
    let folder = folderOf(source)
    let title = target.split('#')[0].split('/').pop()?.trim()
    const across = linkedSpace(target, spaces, space)
    if (across) {
      const parts = across.rest.split('/')
      title = parts.pop()?.trim()
      folder = [across.space, ...parts].join('/')
    }
    if (!title) return
    try {
      const made = await vaultApi.create(folder, title)
      await reload()
      navigate(noteUrl(made.path) + '?edit=1')
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  const shown = found?.space === space ? found : null
  const button = 'shrink-0 rounded-full border border-ink-700 px-2.5 py-0.5 text-xs text-mist-300 hover:bg-ink-850 hover:text-mist-100 disabled:opacity-40'
  return (
    <main className="nn-scroll flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('files.title')}</h1>
          <FilesTabs />
          <p className="mt-3 text-sm text-mist-500">{t('cleanup.intro')}</p>
        </div>
        <label className="flex flex-wrap items-center gap-3 text-sm text-mist-400">
          {t('cleanup.space')}
          <select
            value={space}
            onChange={(event) => choose(event.target.value)}
            className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-mist-100 outline-none focus:border-accent-500"
          >
            {spaces.map((item) => (
              <option key={item.id} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {problem && (
          <p role="alert" className="text-sm text-warn-500">
            {errorText(problem)}
          </p>
        )}
        {!shown && !problem && space && <p className="text-sm text-mist-500">{t('common.loading')}</p>}
        {shown && (
          <>
            <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5" data-testid="cleanup-lonely">
              <h2 className="flex items-center gap-2 font-semibold">
                <Symbol name="note" className="h-4 w-4 text-accent-400" />
                {t('cleanup.lonely')}
                <span className="ml-auto text-sm font-normal text-mist-500 tabular-nums">{shown.lonely_total}</span>
              </h2>
              <p className="mt-1 mb-4 text-sm text-mist-500">{t('cleanup.lonelyText')}</p>
              {shown.lonely.length === 0 && <p className="text-sm text-mist-500">{t('cleanup.lonelyNone')}</p>}
              <ul className="divide-y divide-ink-700">
                {shown.lonely.map((row) => (
                  <li key={row.path} className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-mist-200">{row.title}</span>
                        <span className="block truncate text-xs text-mist-500">{folderOf(row.path)}</span>
                      </span>
                      <button type="button" className={button} onClick={() => navigate(noteUrl(row.path))}>
                        {t('cleanup.open')}
                      </button>
                      <button type="button" className={button} aria-expanded={mentionsOf === row.path} onClick={() => setMentionsOf(mentionsOf === row.path ? null : row.path)}>
                        {t('cleanup.mentions')}
                      </button>
                    </div>
                    {mentionsOf === row.path && (
                      <div className="mt-2 rounded-xl border border-ink-700 bg-ink-950/40 pt-2">
                        <Unlinked path={row.path} alwaysOpen onOpen={(path) => navigate(noteUrl(path))} onLinked={() => setAsk((n) => n + 1)} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {shown.lonely_total > shown.lonely.length && <p className="mt-2 text-xs text-mist-600">{t('cleanup.first', { count: shown.lonely.length })}</p>}
            </section>

            <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5" data-testid="cleanup-broken">
              <h2 className="flex items-center gap-2 font-semibold">
                <Symbol name="link" className="h-4 w-4 text-accent-400" />
                {t('cleanup.broken')}
                <span className="ml-auto text-sm font-normal text-mist-500 tabular-nums">{shown.broken_total}</span>
              </h2>
              <p className="mt-1 mb-4 text-sm text-mist-500">{t('cleanup.brokenText')}</p>
              {shown.broken.length === 0 && <p className="text-sm text-mist-500">{t('cleanup.brokenNone')}</p>}
              <ul className="divide-y divide-ink-700">
                {shown.broken.map((row, index) => (
                  <li key={`${row.path}:${row.line}:${index}`} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-mist-200">{linkName(row.target)}</span>
                      <span className="block truncate text-xs text-mist-500">{t('cleanup.standsIn', { title: row.title, line: row.line })}</span>
                    </span>
                    <button type="button" className={button} onClick={() => navigate(noteUrl(row.path))}>
                      {t('cleanup.openSource')}
                    </button>
                    {!isFileTarget(row.target) && (
                      <button type="button" className={button} disabled={!writable} title={writable ? undefined : t('unlinked.readOnly')} onClick={() => void make(row.path, row.target)}>
                        {t('cleanup.make')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {shown.broken_total > shown.broken.length && <p className="mt-2 text-xs text-mist-600">{t('cleanup.first', { count: shown.broken.length })}</p>}
            </section>
          </>
        )}
      </div>
    </main>
  )
}
