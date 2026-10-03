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
import { usePeek } from '../lib/commentPeek'
import { useContextMenu } from '../lib/menu'
import { CommentPeek } from './CommentPeek'
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

/** The words chosen in the text as a comment's anchor (the selection let go with `release`); null when nothing fits. */
function chosenAnchor(root: HTMLElement | null, release = true): Anchor | null {
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
  if (release) selection.removeAllRanges()
  return words ? anchorOf(text, start + lead, start + lead + words.length) : null
}

/** The thread whose lit words lie under a point of the screen. */
function threadAt(marks: { thread: Thread; range: Range }[], x: number, y: number): { thread: Thread; box: DOMRect; node: Node } | null {
  for (const mark of marks)
    for (const box of mark.range.getClientRects())
      if (x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1)
        return { thread: mark.thread, box, node: mark.range.startContainer }
  return null
}

export function CommentLayer({ article, html, threads, onAsk, onFound, onShowThread }: Props) {
  const { t } = useTranslation()
  const [button, setButton] = useState<{ x: number; y: number } | null>(null)
  const marks = useRef<{ thread: Thread; range: Range }[]>([])
  const { open: openMenu, element: menuElement } = useContextMenu()
  // A move over the text is weighed a frame later, when the mouse may already be on the preview: the preview knows
  // that and stays (it once closed before its button could be reached).
  const peekState = usePeek()
  const { show: showPeek, hideSoon, hide: hidePeek } = peekState

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
    hidePeek()
    const store = highlights()
    store?.set(MARKS, highlight(ranges))
    return () => {
      store?.delete(MARKS)
      marks.current = []
    }
    // onFound is the page's setter; the text changes with html.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article, html, threads, hidePeek])

  // Over lit words: the preview of their thread, below the line they stand in.
  useEffect(() => {
    const root = article.current
    if (!root) return
    let frame = 0
    const show = (x: number, y: number) => {
      // Words being chosen: no preview over them (it covered the words a right click was meant for).
      if (document.getSelection()?.isCollapsed === false) return hidePeek()
      const hit = threadAt(marks.current, x, y)
      if (hit) showPeek(hit.thread, hit.box, hit.node)
      else hideSoon()
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
    const away = () => hideSoon()
    root.addEventListener('mousemove', move)
    root.addEventListener('click', tap)
    root.addEventListener('mouseleave', away)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('mousemove', move)
      root.removeEventListener('click', tap)
      root.removeEventListener('mouseleave', away)
    }
  }, [article, html, showPeek, hideSoon, hidePeek])

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
      // Taken now: by the time an item is clicked, the click may have let the selection go.
      const anchor = chosenAnchor(root, false)
      openMenu(event.clientX, event.clientY, [
        {
          label: t('comments.here'),
          symbol: 'pencil',
          disabled: !anchor,
          onSelect: () => {
            if (anchor) onAsk(anchor)
            document.getSelection()?.removeAllRanges()
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
      hidePeek()
      setButton({ x: Math.min(box.right, window.innerWidth - 140), y: box.bottom + 6 })
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [article, hidePeek])

  const ask = () => {
    const anchor = chosenAnchor(article.current)
    if (anchor) onAsk(anchor)
    setButton(null)
  }

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
      <CommentPeek state={peekState} onShowThread={onShowThread} />
    </>
  )
}
