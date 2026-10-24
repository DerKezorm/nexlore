/**
 * The cover flow: one level of the vault as a fan of cards over the whole window, flipped through like a shelf of
 * records. Spaces and folders show their cover picture (or a pattern in their colour), notes a little of their text.
 * A click on a card at the side brings it to the middle; on the middle one opens the folder one level deeper or reads
 * the note. Arrow keys, the wheel, a drag or the slider flip; letters typed jump; Escape goes up, at the top it closes.
 *
 * Opened from anywhere with `askCoverflow` (header, palette, a folder's menu); lives in the app's frame. What may be
 * seen comes from the server with the reader's rights (`/api/coverflow`), covers too.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ApiError, coverflowApi, coverUrl, fileUrl, vaultApi, type CoverFolder, type CoverItem, type CoverLevel } from '../api/client'
import { COVERFLOW_EVENT, place, settle, trail, typedTo } from '../lib/coverflow'
import { useEnrich } from '../lib/enrich'
import { errorText } from '../lib/errors'
import { appTargets, formatDate, renderMarkdown } from '../lib/markdown'
import { folderOf, noteUrl } from '../lib/vault'
import { folderColor, spaceColor } from '../graph/palette'
import { useStore } from '../state/store'
import { CoverPicker } from './CoverPicker'
import { LookIcon } from './LookIcon'
import { Symbol } from './Symbol'

type Phase = '' | 'out-deeper' | 'out-up' | 'in-deeper' | 'in-up'
type Reading = { path: string; title: string; html: string } | { path: string; state: 'loading' | 'failed' }

const STEP_PX = 40

/** The colour of a folder's pattern: its own, else the one the map gives it. */
function tint(item: CoverFolder, spaceNames: string[]): string {
  if (item.color) return item.color
  if (item.space) return spaceColor(Math.max(0, spaceNames.indexOf(item.name)))
  return folderColor(item.path, true)
}

function coverOf(item: CoverItem | undefined): string | null {
  if (!item) return null
  if (item.kind === 'folder') return item.cover ? coverUrl(item.path, item.cover) : null
  return item.image ? fileUrl(item.image) : null
}

export function Coverflow() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { spaces } = useStore()
  const spaceNames = spaces.map((space) => space.name)
  const [open, setOpen] = useState(false)
  const [level, setLevel] = useState<CoverLevel | null>(null)
  // Where one is going: the line of places follows at once, not when the cards have come.
  const [target, setTarget] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)
  const [position, setPosition] = useState(0)
  const [phase, setPhase] = useState<Phase>('')
  const [dragging, setDragging] = useState(false)
  const [size, setSize] = useState({ width: 300, height: 400 })
  const [reading, setReading] = useState<Reading | null>(null)
  const [picking, setPicking] = useState<CoverFolder | null>(null)
  const [jump, setJump] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const readBody = useRef<HTMLDivElement>(null)
  const before = useRef<HTMLElement | null>(null)
  const asked = useRef(0)
  const items = useMemo(() => level?.items ?? [], [level])

  // One level, `focus` the card to stand in the middle (the folder one came up from).
  const show = useCallback(async (path: string, direction: 0 | 1 | -1, focus?: string) => {
    const ticket = ++asked.current
    setProblem(null)
    setTarget(path)
    if (direction) setPhase(direction > 0 ? 'out-deeper' : 'out-up')
    const waited = new Promise((resolve) => setTimeout(resolve, direction ? 260 : 0))
    try {
      const [next] = await Promise.all([coverflowApi.level(path), waited])
      if (ticket !== asked.current) return
      const at = focus ? Math.max(0, next.items.findIndex((item) => item.path === focus)) : 0
      setLevel(next)
      setCurrent(at)
      setPosition(at)
      if (direction) {
        setPhase(direction > 0 ? 'in-deeper' : 'in-up')
        requestAnimationFrame(() => requestAnimationFrame(() => setPhase('')))
      }
    } catch (error) {
      if (ticket !== asked.current) return
      setPhase('')
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }, [])

  useEffect(() => {
    const ask = (event: Event) => {
      before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(true)
      setReading(null)
      setLevel(null)
      void show((event as CustomEvent<string>).detail ?? '', 0)
    }
    window.addEventListener(COVERFLOW_EVENT, ask)
    return () => window.removeEventListener(COVERFLOW_EVENT, ask)
  }, [show])

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    setOpen(false)
    setReading(null)
    setPicking(null)
    asked.current++
    const back = before.current
    if (back?.isConnected) back.focus()
  }, [])

  useEffect(() => {
    if (open) root.current?.focus()
  }, [open])

  // The size of a card follows the room: three by four, at most a third of the width (two thirds on a phone).
  useLayoutEffect(() => {
    const box = stage.current
    if (!open || !box) return
    const measure = () => {
      const rect = box.getBoundingClientRect()
      const phone = rect.width < 640
      let height = Math.min(rect.height * (phone ? 0.5 : 0.6), 480)
      let width = height * 0.75
      const most = rect.width * (phone ? 0.66 : 0.3)
      if (width > most) {
        width = most
        height = width / 0.75
      }
      setSize({ width: Math.round(width), height: Math.round(height) })
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(box)
    return () => watch.disconnect()
  }, [open])

  const go = useCallback(
    (index: number) => {
      if (!items.length) return
      const next = Math.max(0, Math.min(items.length - 1, index))
      setCurrent(next)
      setPosition(next)
    },
    [items.length],
  )

  const up = useCallback(
    (goal?: string) => {
      if (!level || !level.path) return close()
      const to = goal ?? (level.path.includes('/') ? folderOf(level.path) : '')
      // The card of the folder one came from, one level below where one goes.
      const parts = level.path.split('/')
      const depth = to ? to.split('/').length : 0
      void show(to, -1, parts.slice(0, depth + 1).join('/'))
    },
    [level, close, show],
  )

  const read = useCallback(async (path: string) => {
    setReading({ path, state: 'loading' })
    try {
      const [note, links] = await Promise.all([vaultApi.note(path), vaultApi.links(path)])
      const map = new Map<string, string>()
      for (const link of links.outgoing) if (link.path) map.set(link.target.toLowerCase(), link.path)
      const html = renderMarkdown(note.content, (target) => map.get(target.toLowerCase()) ?? null, path, appTargets(path, false))
      setReading((now) => (now?.path === path ? { path, title: note.title, html } : now))
    } catch {
      setReading((now) => (now?.path === path ? { path, state: 'failed' } : now))
    }
  }, [])
  useEnrich(readBody, reading && 'html' in reading ? reading.html : '')

  const activate = useCallback(() => {
    const item = items[current]
    if (!item) return
    if (item.kind === 'folder') void show(item.path, 1)
    else void read(item.path)
  }, [items, current, show, read])

  const stepNote = useCallback(
    (direction: 1 | -1) => {
      for (let index = current + direction; index >= 0 && index < items.length; index += direction) {
        const item = items[index]
        if (item.kind === 'note') {
          go(index)
          void read(item.path)
          return
        }
      }
    },
    [current, items, go, read],
  )

  const openNote = (path: string) => {
    close()
    navigate(noteUrl(path))
  }

  // Letters typed jump to the first card with that beginning, as in a shelf of records.
  const typed = useRef({ text: '', timer: 0 })
  const typeJump = useCallback(
    (letter: string) => {
      const memory = typed.current
      memory.text += letter
      window.clearTimeout(memory.timer)
      const found = typedTo(items.map((item) => item.name), memory.text)
      setJump(found < 0 ? t('coverflow.jumpNone', { typed: memory.text }) : t('coverflow.jump', { typed: memory.text }))
      if (found >= 0) go(found)
      memory.timer = window.setTimeout(() => {
        memory.text = ''
        setJump(null)
      }, 900)
    },
    [items, go, t],
  )

  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void root.current?.requestFullscreen?.().catch(() => {})
  }, [])

  // The keys, before anything else on the page hears them; the cover dialog has its own.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (picking || event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key
      let handled = true
      if (reading) {
        if (key === 'Escape' || key === 'Backspace') setReading(null)
        else if (key === 'ArrowLeft') stepNote(-1)
        else if (key === 'ArrowRight') stepNote(1)
        else handled = false
      } else if (key === 'ArrowRight') go(current + 1)
      else if (key === 'ArrowLeft') go(current - 1)
      else if (key === 'Home') go(0)
      else if (key === 'End') go(items.length - 1)
      else if (key === 'Enter' || key === ' ' || key === 'ArrowDown') activate()
      else if (key === 'Escape' || key === 'Backspace' || key === 'ArrowUp') up()
      else if (key.length === 1 && /[\p{L}\p{N}]/u.test(key)) typeJump(key)
      else handled = false
      if (!handled) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, picking, reading, current, items.length, go, activate, up, stepNote, typeJump])

  // Dragging with the hand carries on a little with its speed; a press without a move is a click.
  const drag = useRef<{ x: number; start: number; moved: boolean; last: number; at: number; speed: number } | null>(null)
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    drag.current = { x: event.clientX, start: position, moved: false, last: event.clientX, at: performance.now(), speed: 0 }
    stage.current?.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const hand = drag.current
    if (!hand) return
    const moved = event.clientX - hand.x
    if (!hand.moved && Math.abs(moved) > 6) {
      hand.moved = true
      setDragging(true)
    }
    if (!hand.moved) return
    const now = performance.now()
    hand.speed = (event.clientX - hand.last) / Math.max(1, now - hand.at)
    hand.last = event.clientX
    hand.at = now
    const next = Math.max(-0.4, Math.min(items.length - 0.6, hand.start - moved / (size.width * 0.7)))
    setPosition(next)
    setCurrent(Math.round(Math.max(0, Math.min(items.length - 1, next))))
  }
  const onPointerUp = (event: React.PointerEvent) => {
    const hand = drag.current
    drag.current = null
    if (!hand) return
    setDragging(false)
    if (hand.moved) return go(settle(position, hand.speed, items.length))
    const card = document
      .elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest<HTMLElement>('[data-card]'))
      .find(Boolean)
    if (!card) return
    const index = Number(card.dataset.card)
    if (index === current) activate()
    else go(index)
  }
  const wheel = useRef({ sum: 0, at: 0 })
  useEffect(() => {
    const box = stage.current
    if (!open || !box) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const memory = wheel.current
      memory.sum += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const now = performance.now()
      if (Math.abs(memory.sum) >= STEP_PX && now - memory.at > 70) {
        go(current + Math.sign(memory.sum))
        memory.sum = 0
        memory.at = now
      }
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [open, current, go])

  if (!open) return null
  const shown = items[current]
  const glow = coverOf(shown)
  const places = trail(target)
  const counts = (item: CoverFolder) =>
    [
      item.folders ? t('coverflow.folders', { count: item.folders }) : '',
      item.notes ? t('coverflow.notes', { count: item.notes }) : '',
    ]
      .filter(Boolean)
      .join(' · ') || t('coverflow.emptyShort')
  const shownNotes = items.filter((item) => item.kind === 'note').length

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={t('coverflow.title')}
      tabIndex={-1}
      data-testid="coverflow"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-ink-950 text-mist-100 outline-none select-none"
    >
      <div className="nn-cf-glow" data-on={glow ? '' : undefined} style={glow ? { backgroundImage: `url("${glow}")` } : undefined} />
      <div className="nn-cf-vignette" />

      <div className="relative z-10 flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-5 sm:py-4">
        <button
          type="button"
          onClick={() => up()}
          disabled={!target}
          aria-label={t('coverflow.back')}
          title={t('coverflow.back')}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink-700 bg-ink-900/70 backdrop-blur hover:bg-ink-850 disabled:opacity-35"
        >
          <Symbol name="chevronLeft" />
        </button>
        <nav aria-label={t('coverflow.where')} className="flex h-9 min-w-0 items-center gap-0.5 overflow-hidden rounded-full border border-ink-700 bg-ink-900/70 pr-2 pl-3 text-sm backdrop-blur">
          <button
            type="button"
            onClick={() => target && up('')}
            className={'flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 ' + (places.length ? 'text-mist-500 hover:text-mist-100 max-sm:hidden' : 'font-semibold')}
          >
            <Symbol name="home" className="h-3.5 w-3.5" />
            {t('coverflow.all')}
          </button>
          {places.map((part, index) => {
            const last = index === places.length - 1
            return (
              <span key={part.path} className={'flex min-w-0 items-center gap-0.5 ' + (last ? '' : 'max-sm:hidden')}>
                <Symbol name="chevronRight" className="h-3.5 w-3.5 shrink-0 text-mist-600 max-sm:hidden" />
                <button
                  type="button"
                  onClick={() => !last && up(part.path)}
                  aria-current={last ? 'location' : undefined}
                  className={'truncate rounded px-1.5 py-0.5 ' + (last ? 'font-semibold' : 'text-mist-500 hover:text-mist-100')}
                >
                  {part.name}
                </button>
              </span>
            )
          })}
        </nav>
        <span className="flex-1" />
        <button
          type="button"
          onClick={toggleFull}
          aria-label={t('coverflow.fullscreen')}
          title={t('coverflow.fullscreen')}
          className="hidden h-9 w-9 shrink-0 place-items-center rounded-full border border-ink-700 bg-ink-900/70 backdrop-blur hover:bg-ink-850 sm:grid"
        >
          <Symbol name="fit" />
        </button>
        <button
          type="button"
          onClick={close}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink-700 bg-ink-900/70 backdrop-blur hover:bg-ink-850"
        >
          <Symbol name="close" />
        </button>
      </div>

      {jump && (
        <div className="absolute top-16 left-1/2 z-20 -translate-x-1/2 rounded-full border border-ink-700 bg-ink-900/80 px-3.5 py-1.5 text-sm backdrop-blur" role="status">
          {jump}
        </div>
      )}

      <div
        ref={stage}
        className={'nn-cf-stage relative z-[1] min-h-0 flex-1 ' + (dragging ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null
          setDragging(false)
          go(Math.round(position))
        }}
      >
        <div
          className="nn-cf-row"
          data-phase={phase || undefined}
          data-drag={dragging ? '' : undefined}
          style={{ '--cw': `${size.width}px`, '--ch': `${size.height}px` } as CSSProperties}
        >
          {problem && <p className="absolute inset-x-0 top-1/3 text-center text-sm text-bad-500" role="alert">{problem}</p>}
          {level && !items.length && !problem && (
            <div className="nn-cf-card" style={{ transform: 'none' }}>
              <div className="nn-cf-face grid place-items-center border border-dashed border-ink-600 bg-ink-900/60 text-center text-sm text-mist-500">
                <span>
                  <Symbol name="folder" className="mx-auto mb-2 h-6 w-6" />
                  {t('coverflow.empty')}
                </span>
              </div>
            </div>
          )}
          {items.map((item, index) => {
            const at = place(index - position, size.width)
            const center = index === current
            const style: CSSProperties = {
              transform: `translateX(${at.x.toFixed(1)}px) translateZ(${at.z.toFixed(1)}px) rotateY(${at.turn.toFixed(2)}deg)`,
              zIndex: 1000 - Math.round(Math.abs(index - position) * 10),
              opacity: at.opacity,
              visibility: at.hidden ? 'hidden' : undefined,
            }
            return item.kind === 'folder' ? (
              <FolderCard key={item.path} item={item} index={index} center={center} style={style} dim={at.dim} colour={tint(item, spaceNames)} counts={counts(item)} onCover={() => setPicking(item)} />
            ) : (
              <NoteCard key={item.path} item={item} index={index} center={center} style={style} dim={at.dim} />
            )
          })}
        </div>
      </div>

      <div className="relative z-10 flex items-center gap-4 px-4 pt-2 pb-5 sm:px-6">
        <div className="hidden w-56 min-w-0 sm:block">
          <p className="truncate text-[15px] font-semibold">{shown?.name ?? (level?.path.split('/').pop() || t('coverflow.all'))}</p>
          <p className="truncate text-xs text-mist-500">
            {shown?.kind === 'folder' ? counts(shown) : shown?.kind === 'note' ? formatDate(shown.modified) : ''}
          </p>
        </div>
        <div className="flex flex-1 items-center gap-3">
          <input
            type="range"
            min={0}
            max={Math.max(0, items.length - 1)}
            value={current}
            onChange={(event) => go(Number(event.target.value))}
            aria-label={t('coverflow.flip')}
            className="h-1 flex-1 accent-accent-500"
          />
          <span className="text-xs whitespace-nowrap text-mist-500 tabular-nums">{items.length ? `${current + 1} / ${items.length}` : '0 / 0'}</span>
        </div>
        <div className="hidden gap-3 text-xs whitespace-nowrap text-mist-500 lg:flex">
          <span><kbd className="mr-1 rounded border border-ink-700 px-1.5">← →</kbd>{t('coverflow.keyFlip')}</span>
          <span><kbd className="mr-1 rounded border border-ink-700 px-1.5">↵</kbd>{t('coverflow.keyOpen')}</span>
          <span><kbd className="mr-1 rounded border border-ink-700 px-1.5">Esc</kbd>{t('coverflow.keyBack')}</span>
          <span><kbd className="mr-1 rounded border border-ink-700 px-1.5">A–Z</kbd>{t('coverflow.keyJump')}</span>
        </div>
      </div>
      {level && level.total_notes > shownNotes && (
        <p className="relative z-10 -mt-3 pb-3 text-center text-xs text-mist-500">{t('coverflow.more', { shown: shownNotes, count: level.total_notes })}</p>
      )}

      {reading && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onClick={(event) => event.target === event.currentTarget && setReading(null)}>
          <div role="document" className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl">
            <div className="flex items-center gap-2 border-b border-ink-700 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-mist-600">{folderOf(reading.path).replace(/\//g, ' / ')}</p>
                <h2 className="truncate text-xl font-semibold">{'title' in reading ? reading.title : reading.path.split('/').pop()?.replace(/\.md$/i, '')}</h2>
              </div>
              <button type="button" onClick={() => setReading(null)} aria-label={t('common.close')} className="grid h-8 w-8 place-items-center rounded-full hover:bg-ink-850">
                <Symbol name="close" />
              </button>
            </div>
            {'html' in reading ? (
              <div
                ref={readBody}
                className="nn-prose nn-scroll min-h-0 overflow-y-auto px-5 py-4"
                onClick={(event) => {
                  const link = (event.target as HTMLElement).closest('a[data-note], a[href^="/file/"]')
                  if (!link) return
                  event.preventDefault()
                  const note = link.getAttribute('data-note')
                  close()
                  navigate(note ? noteUrl(note) : link.getAttribute('href')!)
                }}
                dangerouslySetInnerHTML={{ __html: reading.html }}
              />
            ) : (
              <p className="px-5 py-6 text-sm text-mist-500">{reading.state === 'loading' ? t('common.loading') : t('preview.failed')}</p>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-ink-700 px-4 py-3">
              <button type="button" onClick={() => stepNote(-1)} className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm hover:bg-ink-850">‹ {t('coverflow.previous')}</button>
              <button type="button" onClick={() => stepNote(1)} className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm hover:bg-ink-850">{t('coverflow.next')} ›</button>
              <span className="flex-1" />
              <button type="button" onClick={() => openNote(reading.path)} className="rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400">
                {t('coverflow.openNote')}
              </button>
            </div>
          </div>
        </div>
      )}

      {picking && (
        <CoverPicker
          folder={picking}
          colour={tint(picking, spaceNames)}
          onClose={() => {
            setPicking(null)
            root.current?.focus()
          }}
          onSaved={(cover) => {
            setLevel((now) =>
              now && { ...now, items: now.items.map((item) => (item.kind === 'folder' && item.path === picking.path ? { ...item, cover } : item)) },
            )
            setPicking(null)
            root.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function FolderCard({ item, index, center, style, dim, colour, counts, onCover }: {
  item: CoverFolder
  index: number
  center: boolean
  style: CSSProperties
  dim: number
  colour: string
  counts: string
  onCover: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className="nn-cf-card"
      data-card={index}
      data-center={center ? '' : undefined}
      data-testid="cover-card"
      aria-label={item.name}
      style={{ ...style, '--glow': `color-mix(in srgb, ${colour} 55%, transparent)`, '--sheet': colour } as CSSProperties}
    >
      <div className="nn-cf-sheet" />
      <div className="nn-cf-sheet" />
      <div className="nn-cf-face">
        {item.cover ? (
          <div className="nn-cf-cover" style={{ backgroundImage: `url("${coverUrl(item.path, item.cover)}")` }} />
        ) : (
          <div className="nn-cf-cover nn-cf-pattern" style={{ '--tint': colour } as CSSProperties}>
            <span className="absolute top-[40%] left-1/2 w-1/3 -translate-x-1/2 -translate-y-1/2 text-white/35">
              {item.icon ? <LookIcon name={item.icon} className="h-auto w-full" /> : <Symbol name={item.space ? 'space' : 'folder'} className="h-auto w-full" />}
            </span>
          </div>
        )}
        <div className="nn-cf-shade" />
        <span className="absolute top-3.5 left-3.5 inline-flex items-center gap-1.5 rounded-full bg-black/35 px-2.5 py-1 text-[11.5px] font-semibold text-white backdrop-blur">
          <Symbol name={item.space ? 'space' : 'folder'} className="h-3.5 w-3.5" />
          {item.space ? t('coverflow.space') : t('coverflow.folder')}
        </span>
        {center && item.writable && (
          <button
            type="button"
            onClick={onCover}
            aria-label={t('coverflow.editCover')}
            title={t('coverflow.editCover')}
            className="absolute top-3 right-3 grid h-8 w-8 place-items-center rounded-full bg-black/35 text-white backdrop-blur hover:bg-black/60"
          >
            <Symbol name="pencil" />
          </button>
        )}
        <div className="absolute inset-x-4 bottom-4 text-white">
          <b className="block truncate leading-tight font-bold tracking-tight [text-shadow:0_2px_12px_rgb(0_0_0/0.5)]" style={{ fontSize: 'calc(var(--ch) * 0.062)' }}>
            {item.name}
          </b>
          <small className="mt-0.5 block text-[12.5px] opacity-85">{counts}</small>
          <span className="nn-cf-go mt-3 inline-flex items-center gap-1 rounded-full border border-white/25 bg-white/15 px-3.5 py-1.5 text-[12.5px] font-semibold backdrop-blur">
            {t('coverflow.open')} <Symbol name="chevronRight" className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
      <div className="nn-cf-dim" style={{ opacity: dim }} />
    </div>
  )
}

function NoteCard({ item, index, center, style, dim }: { item: CoverItem & { kind: 'note' }; index: number; center: boolean; style: CSSProperties; dim: number }) {
  const { t } = useTranslation()
  return (
    <div
      className="nn-cf-card"
      data-card={index}
      data-center={center ? '' : undefined}
      data-testid="cover-card"
      aria-label={item.name}
      style={{ ...style, '--glow': 'color-mix(in srgb, var(--color-accent-500) 35%, transparent)' } as CSSProperties}
    >
      <div className="nn-cf-face flex flex-col bg-ink-850 text-mist-100">
        {item.image ? (
          <div className="h-[38%] shrink-0 bg-cover bg-center" style={{ backgroundImage: `url("${fileUrl(item.image)}")` }} />
        ) : (
          <div className="h-1 shrink-0 bg-accent-500/80" />
        )}
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-4 pb-4">
          <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-mist-500">
            <Symbol name="note" className="h-3.5 w-3.5" />
            {t('coverflow.note')} · {formatDate(item.modified)}
          </p>
          <h3 className="mt-2 mb-2 line-clamp-2 leading-tight font-semibold tracking-tight" style={{ fontSize: 'calc(var(--ch) * 0.05)' }}>
            {item.name}
          </h3>
          <p className="nn-cf-excerpt min-h-0 flex-1 overflow-hidden text-[13px] leading-relaxed text-mist-400">{item.excerpt}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {item.tags.slice(0, 2).map((tag) => (
              <span key={tag} className="rounded-full border border-accent-500/40 bg-accent-500/10 px-2 py-0.5 text-[11.5px] text-accent-400">#{tag}</span>
            ))}
            <span className="nn-cf-go ml-auto inline-flex items-center gap-1 rounded-full bg-accent-500 px-3.5 py-1.5 text-[12.5px] font-semibold text-on-accent">
              {t('coverflow.read')} <Symbol name="chevronRight" className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>
      </div>
      <div className="nn-cf-dim" style={{ opacity: dim }} />
    </div>
  )
}
