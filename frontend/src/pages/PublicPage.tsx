/**
 * A public reading page (`/s/<token>/<note>`): no account, no app around it, only what was shared. A folder shows its
 * notes on the side. Links to notes of the share stay links, everything else is text: the server says which is which.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useEnrich } from '../lib/enrich'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'

import { ApiError, shareApi, type PublicPage as Page, type PublicState } from '../api/client'
import { Field, PrimaryButton, Problem } from '../components/AuthFrame'
import { Logo } from '../components/Logo'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { errorText } from '../lib/errors'
import { renderMarkdown } from '../lib/markdown'
import { publicRoute, publicTargets } from '../lib/public'

export function PublicPage() {
  const { t } = useTranslation()
  const params = useParams()
  const token = params.token ?? ''
  const wanted = params['*'] ? params['*'] : undefined
  const navigate = useNavigate()
  const [state, setState] = useState<PublicState | null>(null)
  const [page, setPage] = useState<Page | null>(null)
  const [missing, setMissing] = useState(false)
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useMemo(
    () => async () => {
      try {
        setState(await shareApi.state(token))
      } catch {
        setMissing(true)
      }
    },
    [token],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!state?.unlocked) return
    const first = state.folder ? state.notes?.[0]?.path : undefined
    const path = wanted ?? first
    if (state.folder && !path) return setPage(null)
    let alive = true
    shareApi.page(token, state.folder ? path : undefined).then(
      (next) => alive && setPage(next),
      () => alive && setPage({ path: '', title: '', content: '', links: [] }),
    )
    return () => {
      alive = false
    }
  }, [state, token, wanted])

  const html = useMemo(() => {
    if (!page || !page.title) return ''
    const { resolve, targets } = publicTargets(token, page)
    return renderMarkdown(page.content, resolve, null, targets)
  }, [page, token])

  const article = useRef<HTMLElement>(null)
  // The boxes of the tasks are named by their words: on a shared page they had no name (P8.18).
  useEffect(() => {
    article.current?.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]').forEach((box) => {
      const words = box.closest('li')?.textContent?.replace(/\s+/g, ' ').trim()
      if (words) box.setAttribute('aria-label', words.slice(0, 120))
    })
  })
  useEnrich(article, html)

  // Links within the share stay in the page instead of loading it again.
  const follow = (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest('a')
    const href = anchor?.getAttribute('href')
    if (!href || !href.startsWith(`/s/${encodeURIComponent(token)}/`) || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    navigate(href)
  }

  useEffect(() => {
    if (page?.title) document.title = `${page.title} · nexlore`
  }, [page])

  const unlock = async () => {
    setBusy(true)
    setProblem(null)
    try {
      await shareApi.unlock(token, password)
      await load()
    } catch (error) {
      setProblem(error instanceof ApiError ? errorText(error.code, error.values) : errorText('internal_error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nn-scroll flex min-h-dvh flex-col overflow-y-auto">
      <header className="flex items-center justify-between border-b border-ink-700/80 px-5 py-3">
        <span className="flex items-center gap-3">
          <Logo />
          <span className="text-sm text-mist-500">{state?.name?.replace(/\.md$/i, '')}</span>
        </span>
        <ThemeSwitcher />
      </header>
      {missing ? (
        <main className="mx-auto max-w-md px-6 py-16 text-center">
          <h1 className="text-xl font-bold">{t('public.gone')}</h1>
          <p className="mt-2 text-sm text-mist-500">{t('public.goneText')}</p>
        </main>
      ) : state && !state.unlocked ? (
        <main className="mx-auto w-full max-w-sm px-4 py-16">
          <h1 className="text-xl font-bold">{t('public.locked')}</h1>
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void unlock()
            }}
          >
            <Problem text={problem} />
            <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoFocus />
            <PrimaryButton busy={busy}>{t('public.open')}</PrimaryButton>
          </form>
        </main>
      ) : (
        <div className="mx-auto flex w-full max-w-6xl flex-1 gap-8 px-4 py-8 md:px-8">
          {state?.folder && (state.notes?.length ?? 0) > 0 && (
            <nav aria-label={t('public.contents')} className="hidden w-56 shrink-0 md:block">
              <ul className="sticky top-6 space-y-0.5 text-sm">
                {state.notes!.map((note) => (
                  <li key={note.path}>
                    <a
                      href={publicRoute(token, note.path)}
                      onClick={follow}
                      aria-current={page?.path === note.path ? 'page' : undefined}
                      className={
                        'block truncate rounded-md px-2 py-1 ' +
                        (page?.path === note.path ? 'bg-accent-500/15 text-accent-400' : 'text-mist-400 hover:bg-ink-850 hover:text-mist-100')
                      }
                    >
                      {note.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <main className="min-w-0 flex-1">
            {state?.folder && (state.notes?.length ?? 0) > 1 && (
              <label className="mb-6 block text-sm md:hidden">
                <span className="sr-only">{t('public.contents')}</span>
                <select
                  value={page?.path ?? ''}
                  onChange={(event) => navigate(publicRoute(token, event.target.value))}
                  className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2"
                >
                  {state.notes!.map((note) => (
                    <option key={note.path} value={note.path}>
                      {note.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {page && !page.title &&<p className="text-sm text-mist-500">{t('public.noPage')}</p>}
            {page?.title && (
              <article ref={article} className="nn-prose max-w-3xl" onClick={follow} dangerouslySetInnerHTML={{ __html: html }} />
            )}
            {state?.folder && state.notes?.length === 0 && <p className="text-sm text-mist-500">{t('public.empty')}</p>}
          </main>
        </div>
      )}
      <footer className="px-5 py-4 text-center text-xs text-mist-600">{t('public.footer')}</footer>
    </div>
  )
}
