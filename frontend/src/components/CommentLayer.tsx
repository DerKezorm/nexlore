/**
 * Comments over the text as it is read: the words of each open thread lit (the CSS Highlight API, so the page's own
 * elements stay untouched), a small "Comment" button beside words chosen in the text, and over lit words a preview
 * of their thread with the way to it in the column (the mouse resting on them, or a tap on a touch screen). The
 * editor has none of it: while writing, the column lists the threads, and their words are lit again when reading.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import type { Thread } from '../api/client'
import { anchorOf, highlight, highlights, locate, MARKS, rangeOf, textMap, type Anchor } from '../lib/comments'
import { formatDate } from '../lib/markdown'
import { useContextMenu } from '../lib/menu'
import { Symbol } from './Symbol'

type Props = {
  article: RefObject<HTMLElement | null>
  /** Changes when the text is drawn anew. */
  html: string
  threads: Thread[] | null
  onAsk: (anchor: Anchor) => void
  /** Which threads' words are in the text now. */
  onFound: (found: Set<number>) => void
  /** Show a thread in the column. */
  onShowThread: (id: number) => void
}

/** How long the preview waits before it goes, so the mouse can move onto it. */
const LINGER_MS = 450

/** The words chosen in the text as a comment's anchor, and the selection let go; null when nothing fits. */
function chosenAnchor(root: HTMLElement | null): Anchor | null {
  const selection = document.getSelection()
  if (!root || !selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  const before = document.createRange()
  before.setStart(root, 0)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  const text = textMap(root).text
  // Blanks at the edges of what was chosen are not part of the words.
  const chosen = range.toString()
  const lead = chosen.length - chosen.trimStart().length
  const words = chosen.trim()
  selection.removeAllRanges()
  return words ? anchorOf(text, start + lead, start + lead + words.length) : null
}

/** The thread whose lit words lie under a point of the screen. */
function threadAt(marks: { thread: Thread; range: Range }[], x: number, y: number): { thread: Thread; box: DOMRect } | null {
  for (const mark of marks)
    for (const box of mark.range.getClientRects())
      if (x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1) return { thread: mark.thread, box }
  return null
}

export function CommentLayer({ article, html, threads, onAsk, onFound, onShowThread }: Props) {
  const { t } = useTranslation()
  const [button, setButton] = useState<{ x: number; y: number } | null>(null)
  const [peek, setPeek] = useState<{ thread: Thread; x: number; y: number } | null>(null)
  const marks = useRef<{ thread: Thread; range: Range }[]>([])
  const { open: openMenu, element: menuElement } = useContextMenu()
  const leave = useRef(0)
  // The mouse on the preview: nothing over the text closes it then (a move over the text is weighed a frame later,
  // when the mouse may already be on the preview: it closed before the button could be reached).
  const onPeek = useRef(false)
  const closeSoon = () => {
    window.clearTimeout(leave.current)
    leave.current = window.setTimeout(() => !onPeek.current && setPeek(null), LINGER_MS)
  }

  // The words of the open threads, lit; which ones were found goes to the column.
  useEffect(() => {
    const root = article.current
    if (!root || !threads) return
    const map = textMap(root)
    const ranges: Range[] = []
    const found = new Set<number>()
    marks.current = []
    for (const thread of threads) {
      const place = locate(map.text, thread)
      if (!place) continue
      found.add(thread.id)
      if (thread.resolved) continue
      const range = rangeOf(map, place.start, place.end)
      if (!range) continue
      ranges.push(range)
      marks.current.push({ thread, range })
    }
    onFound(found)
    setPeek(null)
    const store = highlights()
    store?.set(MARKS, highlight(ranges))
    return () => {
      store?.delete(MARKS)
      marks.current = []
    }
    // onFound is the page's setter; the text changes with html.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article, html, threads])

  // Over lit words: the preview of their thread, below the line they stand in.
  useEffect(() => {
    const root = article.current
    if (!root) return
    let frame = 0
    const show = (x: number, y: number) => {
      const hit = threadAt(marks.current, x, y)
      if (hit) {
        window.clearTimeout(leave.current)
        setPeek((was) =>
          was?.thread.id === hit.thread.id ? was : { thread: hit.thread, x: Math.min(hit.box.left, window.innerWidth - 300), y: hit.box.bottom + 2 },
        )
      } else if (!onPeek.current) closeSoon()
    }
    const move = (event: MouseEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => show(event.clientX, event.clientY))
    }
    // A touch screen has no hovering: a tap on lit words shows the preview.
    const tap = (event: MouseEvent) => {
      if (document.getSelection()?.isCollapsed === false) return
      show(event.clientX, event.clientY)
    }
    const away = () => closeSoon()
    root.addEventListener('mousemove', move)
    root.addEventListener('click', tap)
    root.addEventListener('mouseleave', away)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(leave.current)
      root.removeEventListener('mousemove', move)
      root.removeEventListener('click', tap)
      root.removeEventListener('mouseleave', away)
    }
  }, [article, html])

  // Scrolling moves the words away from a preview that stays where it was: it goes.
  useEffect(() => {
    if (!peek) return
    const gone = () => setPeek(null)
    window.addEventListener('scroll', gone, true)
    return () => window.removeEventListener('scroll', gone, true)
  }, [peek])

  // The right button on words chosen in the text: "Comment" first, copying beside it.
  useEffect(() => {
    const root = article.current
    if (!root) return
    const context = (event: MouseEvent) => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) return
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer) || !range.toString().trim()) return
      event.preventDefault()
      openMenu(event.clientX, event.clientY, [
        {
          label: t('comments.here'),
          symbol: 'pencil',
          onSelect: () => {
            const anchor = chosenAnchor(root)
            if (anchor) onAsk(anchor)
          },
        },
        { label: t('editorMenu.copy'), symbol: 'copy', hint: t('editorMenu.keyCopy'), onSelect: () => void document.execCommand('copy') },
      ])
    }
    root.addEventListener('contextmenu', context)
    return () => root.removeEventListener('contextmenu', context)
  }, [article, html, t, openMenu, onAsk])

  // Words chosen in the text: the button beside their end.
  useEffect(() => {
    const changed = () => {
      const root = article.current
      const selection = document.getSelection()
      if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return setButton(null)
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer) || !range.toString().trim()) return setButton(null)
      const box = range.getBoundingClientRect()
      setPeek(null)
      setButton({ x: Math.min(box.right, window.innerWidth - 140), y: box.bottom + 6 })
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [article])

  const ask = () => {
    const anchor = chosenAnchor(article.current)
    if (anchor) onAsk(anchor)
    setButton(null)
  }

  const first = peek?.thread.comments[0]
  const replies = peek ? peek.thread.comments.length - 1 : 0
  return (
    <>
      {menuElement}
      {button && (
        <button
          type="button"
          data-testid="comment-here"
          onMouseDown={(event) => event.preventDefault()}
          onClick={ask}
          style={{ left: button.x, top: button.y }}
          className="fixed z-30 inline-flex items-center gap-1.5 rounded-full border border-accent-500/60 bg-ink-900 px-3 py-1 text-xs font-semibold text-accent-300 shadow-lg hover:bg-ink-850"
        >
          <Symbol name="pencil" className="h-3.5 w-3.5" />
          {t('comments.here')}
        </button>
      )}
      {peek && first && (
        <div
          role="dialog"
          aria-label={t('comments.peek')}
          data-testid="comment-peek"
          data-thread={peek.thread.id}
          style={{ left: Math.max(8, peek.x), top: peek.y }}
          onMouseEnter={() => {
            onPeek.current = true
            window.clearTimeout(leave.current)
          }}
          onMouseLeave={() => {
            onPeek.current = false
            closeSoon()
          }}
          className="fixed z-30 w-72 max-w-[calc(100vw-16px)] rounded-xl border border-ink-700 bg-ink-900 p-3 text-sm shadow-2xl"
        >
          <div className="flex items-baseline gap-2 text-xs text-mist-500">
            <span className="font-semibold text-mist-300">{first.author}</span>
            <span>{formatDate(first.created_at)}</span>
          </div>
          <p className="mt-1 line-clamp-4 break-words whitespace-pre-wrap text-mist-200">{first.body}</p>
          <div className="mt-2 flex items-center gap-2 text-xs">
            {replies > 0 && <span className="text-mist-500">{t('comments.replies', { count: replies })}</span>}
            <button
              type="button"
              onClick={() => {
                onShowThread(peek.thread.id)
                onPeek.current = false
                setPeek(null)
              }}
              className="ml-auto inline-flex items-center gap-1 font-semibold text-accent-400 hover:text-accent-300"
            >
              {t('comments.toThread')}
              <Symbol name="chevronRight" className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
