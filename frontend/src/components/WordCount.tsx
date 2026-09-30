/**
 * The line under a note: its words and characters, or those of the words chosen in it (`lib/wordcount.ts`). Counted
 * again a moment after the text changes (typing, the note loading, a switch between reading and writing).
 */
import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { count, countIn, type Count } from '../lib/wordcount'

/** Time the text gets to settle before it is counted again. */
const SETTLE_MS = 200

export function WordCount({ body, content }: { body: RefObject<HTMLElement | null>; content: string }) {
  const { t, i18n } = useTranslation()
  const [total, setTotal] = useState<Count | null>(null)
  const [chosen, setChosen] = useState<Count | null>(null)

  useEffect(() => {
    const element = body.current
    if (!element) return
    let timer = 0
    const measure = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const text = element.querySelector<HTMLElement>(content)
        setTotal(text ? countIn(text) : null)
      }, SETTLE_MS)
    }
    const watch = new MutationObserver(measure)
    watch.observe(element, { subtree: true, childList: true, characterData: true })
    measure()
    const choose = () => {
      const selection = document.getSelection()
      const text = element.querySelector(content)
      const inside = selection && !selection.isCollapsed && text && text.contains(selection.anchorNode) && text.contains(selection.focusNode)
      setChosen(inside ? count(selection.toString()) : null)
    }
    document.addEventListener('selectionchange', choose)
    return () => {
      window.clearTimeout(timer)
      watch.disconnect()
      document.removeEventListener('selectionchange', choose)
    }
  }, [body, content])

  if (!total) return null
  const shown = (what: Count) =>
    `${t('wordcount.words', { count: what.words, n: what.words.toLocaleString(i18n.language) })} · ${t('wordcount.chars', { count: what.chars, n: what.chars.toLocaleString(i18n.language) })}`
  return (
    <div className="hidden shrink-0 justify-end border-t border-ink-800 px-4 py-1 text-[11px] text-mist-500 tabular-nums sm:flex" data-testid="word-count">
      {chosen && chosen.words + chosen.chars > 0 ? t('wordcount.chosen', { what: shown(chosen) }) : shown(total)}
    </div>
  )
}
