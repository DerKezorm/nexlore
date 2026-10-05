/**
 * Frag Lore, the page (design answers 05.10.2026): the own conversations on the left, grouped by day, the open one in
 * the middle, and under the field the spaces Lore looks in, each one to leave out (kept with the account). Without an
 * AI service Lore says what is missing and where to put it in. On a phone the list is a sheet.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { aiApi, loreApi, type AiState, type LoreListed } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { LoreChat } from '../components/LoreChat'
import { LoreSpider } from '../components/LoreSpider'
import { Symbol } from '../components/Symbol'
import { spaceColor } from '../graph/palette'
import { useLoreSpaces } from '../lib/useLoreSpaces'
import { useAuth } from '../state/auth'

const SUGGESTIONS = ['week', 'overdue', 'decided', 'clash'] as const

function dayOf(when: string): 'today' | 'yesterday' | 'week' | 'earlier' {
  const then = new Date(when)
  const now = new Date()
  const days = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(then.getFullYear(), then.getMonth(), then.getDate())) / 86400000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? 'week' : 'earlier'
}

export function LorePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const params = useParams()
  const { spaces, hidden, chosen, toggle } = useLoreSpaces()
  const { me } = useAuth()
  const shown = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null
  const [conversation, setConversation] = useState<number | null>(shown)
  const [list, setList] = useState<LoreListed[] | null>(null)
  const [state, setState] = useState<AiState | null>(null)
  const [sheet, setSheet] = useState(false)
  const [removing, setRemoving] = useState<LoreListed | 'all' | null>(null)

  useEffect(() => setConversation(shown), [shown])
  const refresh = useCallback(() => void loreApi.list().then(setList, () => setList([])), [])
  useEffect(() => {
    aiApi.state().then(setState, () => setState(null))
    refresh()
  }, [refresh])

  const open = (id: number | null) => {
    setSheet(false)
    navigate(id === null ? '/lore' : `/lore/${id}`)
  }
  const title = list?.find((item) => item.id === conversation)?.title

  if (me && !me.lore_allowed) return <NoThread why={me.ai_allowed ? 'loreOff' : 'off'} />
  if (state && !state.ready) return <NoThread why={!state.allowed ? 'off' : state.mode === 'shared' ? 'shared' : 'own'} />

  const groups = (['today', 'yesterday', 'week', 'earlier'] as const)
    .map((day) => ({ day, items: (list ?? []).filter((item) => dayOf(item.updated_at) === day) }))
    .filter((group) => group.items.length)

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={
          (sheet ? 'fixed inset-x-0 bottom-0 z-40 max-h-[80%] rounded-t-2xl border-t shadow-2xl ' : 'hidden ') +
          'nn-scroll w-full shrink-0 flex-col overflow-y-auto border-ink-700 bg-ink-950 p-3 md:static md:flex md:max-h-none md:w-64 md:rounded-none md:border-t-0 md:border-r md:shadow-none'
        }
        aria-label={t('lore.conversations')}
        data-testid="lore-list"
      >
        <button
          type="button"
          onClick={() => open(null)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-accent-500/40 bg-accent-500/10 px-3 py-2 text-sm font-semibold text-accent-400 hover:bg-accent-500/15"
        >
          <Symbol name="plus" /> {t('lore.newChat')}
        </button>
        {list && list.length === 0 && <p className="mt-4 px-2 text-sm text-mist-500">{t('lore.noneYet')}</p>}
        {groups.map((group) => (
          <section key={group.day} className="mt-4">
            <h2 className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-mist-500 uppercase">{t(`lore.days.${group.day}`)}</h2>
            <ul>
              {group.items.map((item) => (
                <li key={item.id} className="group relative">
                  <Link
                    to={`/lore/${item.id}`}
                    onClick={() => setSheet(false)}
                    aria-current={item.id === conversation ? 'page' : undefined}
                    className={'block truncate rounded-lg py-1.5 pr-8 pl-2.5 text-sm ' + (item.id === conversation ? 'bg-accent-500/12 text-accent-400' : 'text-mist-300 hover:bg-ink-850')}
                  >
                    {item.note && <Symbol name="note" className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-mist-500" />}
                    {item.title}
                  </Link>
                  <button
                    type="button"
                    onClick={() => setRemoving(item)}
                    aria-label={t('lore.remove', { title: item.title })}
                    title={t('lore.removeShort')}
                    className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-mist-500 opacity-0 group-hover:opacity-100 hover:text-bad-500 focus:opacity-100 [@media(pointer:coarse)]:opacity-100"
                  >
                    <Symbol name="trash" className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="mt-5 px-2 text-xs text-mist-500">{state ? t('lore.kept', { count: state.keep_days }) : null}</p>
        {list && list.length > 1 && (
          <button type="button" onClick={() => setRemoving('all')} className="mt-2 px-2 text-xs text-bad-500 hover:underline">
            {t('lore.removeAll')}
          </button>
        )}
      </aside>
      {sheet && <button type="button" aria-label={t('common.close')} className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setSheet(false)} />}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2.5 sm:px-6">
          <button type="button" onClick={() => setSheet(true)} aria-label={t('lore.conversations')} className="rounded-full border border-ink-600 p-1.5 text-mist-300 md:hidden">
            <Symbol name="sidebar" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title ?? t('lore.title')}</h1>
          {state && (
            <span className="hidden shrink-0 text-xs text-mist-500 sm:inline" data-testid="lore-model">
              {state.mode === 'shared' ? t('lore.modelShared', { model: state.shared.model }) : state.access.model}
            </span>
          )}
        </div>
        <LoreChat
          conversation={conversation}
          spaces={chosen}
          onConversation={(id) => {
            setConversation(id)
            navigate(`/lore/${id}`, { replace: true })
          }}
          onAnswered={refresh}
          placeholder={t('lore.placeholder')}
          empty={(ask) => (
            <div className="px-2 pt-10 pb-4 text-center">
              <LoreSpider className="mx-auto h-20 w-24" />
              <h2 className="mt-3 text-xl font-semibold">{t('lore.emptyTitle')}</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-mist-500">{t('lore.emptyText')}</p>
              <div className="mx-auto mt-6 grid max-w-2xl gap-2 text-left sm:grid-cols-2">
                {SUGGESTIONS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => ask(t(`lore.suggest.${key}`))}
                    className="rounded-xl border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-mist-200 hover:border-accent-500/50"
                  >
                    {t(`lore.suggest.${key}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          footer={
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-mist-500" role="group" aria-label={t('lore.looksIn')} data-testid="lore-spaces">
              <span>{t('lore.sees')}</span>
              {spaces.length > 1 && <span className="ml-1">· {t('lore.looksIn')}</span>}
              {spaces.length > 1 &&
                spaces.map((space, index) => (
                  <button
                    key={space.id}
                    type="button"
                    aria-pressed={!hidden.has(space.id)}
                    onClick={() => toggle(space.id)}
                    className={
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ' +
                      (hidden.has(space.id) ? 'border-ink-700 text-mist-600 line-through' : 'border-ink-600 bg-ink-900 text-mist-200')
                    }
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: spaceColor(index) }} aria-hidden="true" />
                    {space.name}
                  </button>
                ))}
            </div>
          }
        />
      </main>

      <ConfirmDialog
        open={removing !== null}
        title={removing === 'all' ? t('lore.removeAllTitle') : t('lore.removeTitle')}
        confirm={t('lore.removeShort')}
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing
          setRemoving(null)
          if (!target) return
          void (target === 'all' ? loreApi.removeAll() : loreApi.remove(target.id)).then(() => {
            refresh()
            if (target === 'all' || target.id === conversation) open(null)
          })
        }}
      >
        {removing === 'all' ? t('lore.removeAllText') : t('lore.removeText', { title: removing?.title ?? '' })}
      </ConfirmDialog>
    </div>
  )
}

function NoThread({ why }: { why: 'off' | 'loreOff' | 'shared' | 'own' }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center" data-testid="lore-no-thread">
      <div className="max-w-md">
        <LoreSpider className="mx-auto h-20 w-24 opacity-75" />
        <h1 className="mt-3 text-xl font-semibold">{t('lore.noThreadTitle')}</h1>
        <p className="mt-1 text-sm text-mist-500">{t(`lore.noThread.${why}`)}</p>
        {why === 'own' && (
          <Link to="/account?tab=ai#ai" className="mt-5 inline-block rounded-full bg-accent-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-400">
            {t('lore.setUp')}
          </Link>
        )}
        {why !== 'own' && me?.role === 'operator' && (
          <Link to="/settings?tab=server&sub=extensions#ai" className="mt-5 inline-block rounded-full border border-accent-500/50 px-4 py-2 text-sm text-accent-400">
            {t('lore.toSettings')}
          </Link>
        )}
      </div>
    </div>
  )
}
