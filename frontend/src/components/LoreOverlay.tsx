/**
 * Lore in the corner (design answer 05.10.2026): a round spider button at the bottom right of every page opens a chat
 * window above it; on a phone the window takes the screen. Only where the operator switched Lore on and an AI service
 * stands ready (`me.lore`), and not on the page "Ask Lore" itself.
 *
 * The window knows the note open in the page: "About: <note>" goes along with every question (the note whole, with
 * the notes it links to, and an answer can become a proposal for it); × asks without it until another note opens.
 * The conversation stays across pages and reloads of the tab; a dot on the button says an answer came while closed.
 *
 * The corner belongs to the spider: while it shows, `--lore-corner` on the root says how much room it takes from the
 * bottom, and whatever else sits in that corner (the zoom of the map) moves up by it. On a phone the spider steps
 * aside while one writes outside the window, so that it covers neither the field nor the row above the keyboard.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { aiApi, type AiState } from '../api/client'
import { spaceColor } from '../graph/palette'
import { useLoreSpaces } from '../lib/useLoreSpaces'
import { decodedOrNull } from '../lib/vault'
import { useAuth } from '../state/auth'
import { LoreChat } from './LoreChat'
import { LoreSpider } from './LoreSpider'
import { Symbol } from './Symbol'

const OPEN_KEY = 'nexlore.loreOpen'
const TALK_KEY = 'nexlore.loreConversation'
const QUICK = ['sum', 'gap', 'rel'] as const
/** The room the spider takes from the bottom of the window: its 3.5rem, 1.25rem below, a little air above. */
const CORNER = '5.25rem'

function stored(key: string, store: Storage): string | null {
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

function keep(key: string, value: string | null, store: Storage): void {
  try {
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  } catch {
    // Private windows may refuse: the window simply starts closed and new.
  }
}

/** Whether a focus means typing: a field or text one can write in. */
function writes(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return !target.readOnly
  return target instanceof HTMLInputElement && !target.readOnly && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(target.type)
}

/** The vault path of the note shown, or null on any other page. */
function noteOf(pathname: string): string | null {
  if (!pathname.startsWith('/note/')) return null
  const path = decodedOrNull(pathname.slice('/note/'.length))
  return path && /\.md$/i.test(path) ? path : null
}

export function LoreOverlay() {
  const { me } = useAuth()
  const location = useLocation()
  if (!me?.lore || location.pathname === '/lore' || location.pathname.startsWith('/lore/')) return null
  return <Overlay />
}

function Overlay() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { spaces, hidden, chosen, toggle } = useLoreSpaces()
  const [open, setOpen] = useState(() => stored(OPEN_KEY, localStorage) === 'open')
  const [big, setBig] = useState(false)
  const [conversation, setConversation] = useState<number | null>(() => {
    const value = Number(stored(TALK_KEY, sessionStorage))
    return Number.isInteger(value) && value > 0 ? value : null
  })
  const [unread, setUnread] = useState(false)
  const [state, setState] = useState<AiState | null>(null)
  const [picking, setPicking] = useState(false)
  const notePath = noteOf(location.pathname)
  const [without, setWithout] = useState<string | null>(null)
  const note = notePath && notePath !== without ? notePath : undefined
  const noteName = notePath ? notePath.split('/').pop()!.replace(/\.md$/i, '') : ''
  const openRef = useRef(open)
  openRef.current = open
  const [typing, setTyping] = useState(false)
  const shown = !typing

  useEffect(() => keep(OPEN_KEY, open ? 'open' : null, localStorage), [open])
  useEffect(() => {
    if (!shown) return
    const root = document.documentElement
    root.style.setProperty('--lore-corner', CORNER)
    return () => {
      root.style.removeProperty('--lore-corner')
    }
  }, [shown])
  useEffect(() => {
    // Only on a phone, and only outside the window: there the keyboard and its row need the bottom of the screen.
    const phone = window.matchMedia('(max-width: 639px)')
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(document.querySelector('[data-testid="lore-overlay"]')?.contains(target))
    const focused = (event: FocusEvent) => setTyping(phone.matches && writes(event.target) && !inside(event.target))
    const left = (event: FocusEvent) => !writes(event.relatedTarget) && setTyping(false)
    document.addEventListener('focusin', focused)
    document.addEventListener('focusout', left)
    return () => {
      document.removeEventListener('focusin', focused)
      document.removeEventListener('focusout', left)
    }
  }, [])
  useEffect(() => keep(TALK_KEY, conversation === null ? null : String(conversation), sessionStorage), [conversation])
  useEffect(() => {
    if (open && !state) aiApi.state().then(setState, () => undefined)
  }, [open, state])
  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => event.key === 'Escape' && !picking && setOpen(false)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, picking])

  const shownSpaces = useMemo(() => spaces.filter((space) => !hidden.has(space.id)).length, [spaces, hidden])
  const model = state ? (state.mode === 'shared' ? t('lore.modelShared', { model: state.shared.model }) : state.access.model) : ''

  return (
    <>
      {shown && (<button
        type="button"
        onClick={() => {
          setOpen(!open)
          setUnread(false)
        }}
        aria-label={open ? t('lore.close') : t('lore.title')}
        aria-expanded={open}
        title={t('lore.title')}
        data-testid="lore-fab"
        className={'fixed right-5 bottom-5 z-30 grid h-14 w-14 place-items-center rounded-full border border-ink-700 bg-ink-950 shadow-2xl hover:border-accent-500/60 ' + (open ? 'max-sm:hidden' : '')}
      >
        <LoreSpider className="h-9 w-10" />
        {unread && <span className="absolute top-1.5 right-1.5 h-3 w-3 rounded-full border-2 border-ink-950 bg-accent-500" data-testid="lore-unread" />}
      </button>)}
      {open && (
        <section
          role="dialog"
          aria-label={t('lore.title')}
          data-testid="lore-overlay"
          className={
            'fixed z-30 flex flex-col overflow-hidden border-ink-700 bg-ink-950 shadow-2xl max-sm:inset-0 sm:right-5 sm:bottom-[5.5rem] sm:rounded-[20px] sm:border ' +
            (big ? 'sm:h-[calc(100dvh-7.5rem)] sm:w-[40rem]' : 'sm:h-[min(40rem,calc(100dvh-7.5rem))] sm:w-[26rem]')
          }
        >
          <header className="flex items-center gap-2.5 border-b border-ink-700 py-2.5 pr-2 pl-4">
            <LoreSpider className="h-7 w-8 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] leading-tight font-semibold">{t('lore.title')}</h2>
              <p className="truncate text-[11.5px] text-mist-500">{model ? `${model} · ${t('lore.sees')}` : t('lore.sees')}</p>
            </div>
            <button type="button" onClick={() => setConversation(null)} aria-label={t('lore.newChat')} title={t('lore.newChat')} className="grid h-8 w-8 place-items-center rounded-lg text-mist-500 hover:bg-ink-850 hover:text-mist-100">
              <Symbol name="plus" />
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                navigate(conversation === null ? '/lore' : `/lore/${conversation}`)
              }}
              aria-label={t('lore.allConversations')}
              title={t('lore.allConversations')}
              className="grid h-8 w-8 place-items-center rounded-lg text-mist-500 hover:bg-ink-850 hover:text-mist-100"
            >
              <Symbol name="history" />
            </button>
            <button type="button" onClick={() => setBig(!big)} aria-label={big ? t('lore.smaller') : t('lore.bigger')} title={big ? t('lore.smaller') : t('lore.bigger')} className="grid h-8 w-8 place-items-center rounded-lg text-mist-500 hover:bg-ink-850 hover:text-mist-100 max-sm:hidden">
              <Symbol name={big ? 'minus' : 'fit'} />
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label={t('lore.close')} title={t('lore.close')} className="grid h-8 w-8 place-items-center rounded-lg text-mist-500 hover:bg-ink-850 hover:text-mist-100">
              <Symbol name="close" />
            </button>
          </header>
          <div className="relative flex flex-wrap gap-1.5 px-3.5 pt-2.5">
            {note && (
              <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent-500/40 bg-accent-500/10 py-0.5 pr-1 pl-2.5 text-xs text-accent-400" data-testid="lore-about">
                <span className="truncate">{t('lore.about', { note: noteName })}</span>
                <button type="button" onClick={() => setWithout(notePath)} aria-label={t('lore.withoutNote')} title={t('lore.withoutNote')} className="rounded-full px-1 opacity-70 hover:opacity-100">
                  ×
                </button>
              </span>
            )}
            {spaces.length > 1 && (
              <button
                type="button"
                aria-expanded={picking}
                onClick={() => setPicking(!picking)}
                className="inline-flex items-center gap-1 rounded-full border border-ink-700 bg-ink-900 px-2.5 py-0.5 text-xs text-mist-300 hover:border-ink-600"
                data-testid="lore-spaces-chip"
              >
                {t('lore.inSpaces', { count: shownSpaces })} ▾
              </button>
            )}
            {picking && (
              <div className="absolute top-full right-3.5 left-3.5 z-10 mt-1 rounded-xl border border-ink-700 bg-ink-950 p-2 shadow-xl" role="group" aria-label={t('lore.looksIn')} data-testid="lore-spaces">
                <p className="mb-1 px-1 text-[11px] text-mist-500">{t('lore.looksIn')}</p>
                {spaces.map((space, index) => (
                  <label key={space.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-ink-850">
                    <input type="checkbox" checked={!hidden.has(space.id)} onChange={() => toggle(space.id)} />
                    <span className="h-2 w-2 rounded-full" style={{ background: spaceColor(index) }} aria-hidden="true" />
                    {space.name}
                  </label>
                ))}
                <button type="button" onClick={() => setPicking(false)} className="mt-1 w-full rounded-lg py-1 text-xs text-accent-400 hover:bg-ink-850">
                  {t('common.close')}
                </button>
              </div>
            )}
          </div>
          <LoreChat
            compact
            conversation={conversation}
            onConversation={setConversation}
            note={note}
            spaces={chosen}
            placeholder={t('lore.placeholderShort')}
            onAnswered={() => !openRef.current && setUnread(true)}
            empty={(ask) => (
              <div className="mt-auto px-2 pb-1 text-center" data-testid="lore-hello">
                <LoreSpider className="mx-auto h-16 w-[4.5rem]" />
                <h3 className="mt-2 text-lg font-semibold">{t('lore.emptyTitle')}</h3>
                <p className="mx-auto mt-0.5 mb-3 max-w-xs text-[13px] text-mist-500">{t('lore.emptyShort')}</p>
                {note && <p className="mb-1.5 text-left text-xs text-mist-500">{t('lore.aboutThis', { note: noteName })}</p>}
                <div className="flex flex-col gap-1.5">
                  {(note ? QUICK.map((key) => t(`lore.quick.${key}`)) : [t('lore.suggest.week'), t('lore.suggest.overdue'), t('lore.suggest.decided')]).map((question) => (
                    <button key={question} type="button" onClick={() => ask(question)} className="rounded-[14px] border border-ink-700 bg-ink-950 px-3 py-2 text-left text-[13px] text-mist-300 hover:border-accent-500/50 hover:text-accent-400">
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            )}
          />
        </section>
      )}
    </>
  )
}
