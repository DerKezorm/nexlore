/**
 * Comments over the text as it is read: the words of each open thread lit (the CSS Highlight API, so the page's own
 * elements stay untouched), and a small "Comment" button beside words chosen in the text. The editor has neither:
 * while writing, the column lists the threads, and their words are lit again when reading.
 */
import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import type { Thread } from '../api/client'
import { anchorOf, highlight, highlights, locate, MARKS, rangeOf, textMap, type Anchor } from '../lib/comments'
import { Symbol } from './Symbol'

type Props = {
  article: RefObject<HTMLElement | null>
  /** Changes when the text is drawn anew. */
  html: string
  threads: Thread[] | null
  onAsk: (anchor: Anchor) => void
  /** Which threads' words are in the text now. */
  onFound: (found: Set<number>) => void
}

export function CommentLayer({ article, html, threads, onAsk, onFound }: Props) {
  const { t } = useTranslation()
  const [button, setButton] = useState<{ x: number; y: number } | null>(null)

  // The words of the open threads, lit; which ones were found goes to the column.
  useEffect(() => {
    const root = article.current
    if (!root || !threads) return
    const map = textMap(root)
    const ranges: Range[] = []
    const found = new Set<number>()
    for (const thread of threads) {
      const place = locate(map.text, thread)
      if (!place) continue
      found.add(thread.id)
      if (thread.resolved) continue
      const range = rangeOf(map, place.start, place.end)
      if (range) ranges.push(range)
    }
    onFound(found)
    const store = highlights()
    store?.set(MARKS, highlight(ranges))
    return () => store?.delete(MARKS)
    // onFound is the page's setter; the text changes with html.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article, html, threads])

  // Words chosen in the text: the button beside their end.
  useEffect(() => {
    const changed = () => {
      const root = article.current
      const selection = document.getSelection()
      if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return setButton(null)
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer) || !range.toString().trim()) return setButton(null)
      const box = range.getBoundingClientRect()
      setButton({ x: Math.min(box.right, window.innerWidth - 140), y: box.bottom + 6 })
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [article])

  const ask = () => {
    const root = article.current
    const selection = document.getSelection()
    if (!root || !selection?.rangeCount) return
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
    onAsk(anchorOf(text, start + lead, start + lead + words.length))
    selection.removeAllRanges()
    setButton(null)
  }

  if (!button) return null
  return (
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
  )
}
