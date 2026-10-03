/**
 * The page of a file that is not a note: a picture, a video or a sound shows itself, anything else can be
 * downloaded. The notes that link it are listed, and it can go to the trash. What the browser gets is decided by the
 * server by the file's content (a PDF or an SVG is always a download).
 */
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'

import { ApiError, fileUrl, vaultApi, type Links } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Sidebar } from '../components/Sidebar'
import { BaseView } from '../components/BaseView'
import { Symbol } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { fileKind, isCanvasPath } from '../lib/files'
import { fileRoute } from '../lib/markdown'
import { folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'

/** A canvas has a page of its own, loaded only when one is opened (React Flow and the editor come with it). */
const CanvasPage = lazy(() => import('../canvas/CanvasPage'))

export function FilePage() {
  // Already decoded by the router.
  const path = useParams()['*'] ?? ''
  const { t } = useTranslation()
  if (isCanvasPath(path)) {
    return (
      <Suspense fallback={<p className="m-auto text-sm text-mist-500">{t('common.loading')}</p>}>
        <CanvasPage key={path} path={path} />
      </Suspense>
    )
  }
  return <FileDetails path={path} />
}

function FileDetails({ path }: { path: string }) {
  const { t } = useTranslation()
  const { reload } = useStore()
  const navigate = useNavigate()
  const [links, setLinks] = useState<Links | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const kind = fileKind(path)

  const load = useCallback(async () => {
    setProblem(null)
    try {
      setLinks(await vaultApi.links(path))
    } catch (error) {
      setLinks(null)
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }, [path])
  useEffect(() => void load(), [load])

  const remove = async () => {
    setDeleting(false)
    try {
      await vaultApi.remove(path)
      await reload()
      navigate(links?.backlinks[0] ? noteUrl(links.backlinks[0].path) : '/files')
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  return (
    <>
      <Sidebar activeNote={path} onNote={(next) => navigate(noteUrl(next))} />
      <main className="nn-scroll flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-5 px-6 py-8">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight break-all">
                <Symbol name={kind === 'image' ? 'image' : kind === 'pdf' ? 'pdf' : 'file'} className="h-5 w-5 shrink-0 text-accent-400" />
                {name}
              </h1>
              <p className="mt-1 font-mono text-[11px] text-mist-500">{folderOf(path)}</p>
            </div>
            <a
              href={fileUrl(path, true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400"
            >
              <Symbol name="download" className="h-4 w-4" /> {t('file.download')}
            </a>
            <button
              type="button"
              onClick={() => setDeleting(true)}
              disabled={!links}
              className="rounded-full border border-ink-700 px-4 py-1.5 text-sm text-bad-500 hover:bg-ink-850 disabled:opacity-40"
            >
              {t('file.delete')}
            </button>
          </div>

          {problem ? (
            <p className="rounded-xl border border-bad-500/30 bg-bad-500/10 px-4 py-2.5 text-sm text-bad-500" role="alert">
              {problem === 'not_found' ? t('file.notFound') : errorText(problem)}
            </p>
          ) : (
            path.toLowerCase().endsWith('.base') ? (
              <section className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
                <BaseView source={{ kind: 'file', path }} />
              </section>
            ) : (
            <section className="flex justify-center rounded-2xl border border-ink-700 bg-ink-900 p-4">
              {kind === 'image' && <img src={fileUrl(path)} alt={name} className="max-h-[70vh] max-w-full rounded-lg" />}
              {kind === 'video' && <video src={fileUrl(path)} controls preload="metadata" className="max-h-[70vh] max-w-full rounded-lg" />}
              {kind === 'audio' && <audio src={fileUrl(path)} controls preload="metadata" className="w-full max-w-md" />}
              {(kind === 'pdf' || kind === 'other') && <p className="py-8 text-sm text-mist-500">{t('file.noPreview')}</p>}
            </section>
            )
          )}

          <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5">
            <h2 className="mb-2 flex items-center gap-2 font-semibold">
              <Symbol name="backlink" className="h-4 w-4 text-accent-400" />
              {t('file.usedIn')}
              <span className="ml-auto text-sm text-mist-600 tabular-nums">{links?.backlinks.length ?? ''}</span>
            </h2>
            {links && links.backlinks.length === 0 && <p className="text-sm text-mist-500">{t('file.unused')}</p>}
            <ul>
              {links?.backlinks.map((item) => (
                <li key={item.path + item.line}>
                  <button type="button" onClick={() => navigate(isCanvasPath(item.path) ? fileRoute(item.path) : noteUrl(item.path))} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink-850">
                    <span className="block text-sm font-medium text-mist-200">{item.title}</span>
                    <span className="block truncate text-xs text-mist-500">{folderOf(item.path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
      <ConfirmDialog
        open={deleting}
        title={t('file.deleteTitle', { name })}
        confirm={t('file.deleteDo')}
        onCancel={() => setDeleting(false)}
        onConfirm={() => void remove()}
      >
        {links && links.backlinks.length > 0 ? t('file.deleteUsed', { count: links.backlinks.length }) : t('file.deleteText')}
      </ConfirmDialog>
    </>
  )
}
