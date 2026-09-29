/**
 * The outline of a note beside it, as Obsidian's core plugin: its headings, indented by level, a click scrolls there.
 * The heading at the top of the text while scrolling is lit. Embedded notes bring their own headings; they are not
 * part of this note's outline.
 */
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { headingsOf } from '../lib/outline'

const TOP = 96

/** In the tab beside the note the tab names it: no heading of its own, and a note without headings says so. */
export function Outline({ content, scroller, onReveal }: { content: string; scroller: RefObject<HTMLElement | null>; onReveal: (text: string, index: number) => void }) {
  const { t } = useTranslation()
  const headings = useMemo(() => headingsOf(content), [content])
  const [active, setActive] = useState(-1)

  useEffect(() => {
    const root = scroller.current
    if (!root || headings.length === 0) return
    let frame = 0
    const measure = () => {
      frame = 0
      const box = root.getBoundingClientRect()
      // Scrolled to the end, a heading near the end never reaches the top: then the last one in view counts.
      const end = root.scrollTop + root.clientHeight >= root.scrollHeight - 2 && root.scrollTop > 0
      const line = end ? box.bottom - 1 : box.top + TOP
      const shown = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter((element) => !element.closest('.nn-embed-note, .nn-embedded'))
      let at = -1
      shown.forEach((element, index) => {
        if (element.getBoundingClientRect().top <= line) at = index
      })
      // At the very top the first heading is the one in view, even when the name of the note above pushes it down.
      if (at < 0 && root.scrollTop <= 0 && shown.length > 0) at = 0
      setActive(at >= 0 ? Math.min(at, headings.length - 1) : -1)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scroller, headings])

  if (headings.length === 0) return <p className="px-2 text-sm text-mist-600" data-testid="outline">{t('outline.empty')}</p>
  const lowest = Math.min(...headings.map((heading) => heading.level))
  return (
    <section data-testid="outline" aria-label={t('outline.title')}>
      <ul>
        {headings.map((heading, index) => (
          <li key={index}>
            <button
              type="button"
              onClick={() => onReveal(heading.text, index)}
              aria-current={index === active ? 'location' : undefined}
              className={'block w-full truncate rounded-lg py-0.5 pr-2 text-left text-sm hover:bg-ink-850 ' + (index === active ? 'text-accent-300' : 'text-mist-400')}
              style={{ paddingLeft: `${0.5 + (heading.level - lowest) * 0.8}rem` }}
              title={heading.text}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
