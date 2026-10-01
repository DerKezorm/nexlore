/**
 * The preview of a comment over its words, in the reading view and in the editor alike: who wrote it, its words, how
 * many answered, and the way to the thread in the column. It sits right under the line, stays while the mouse is on
 * it, and goes a moment after the mouse left both it and the words (or when the page scrolls).
 */
import { useTranslation } from 'react-i18next'

import type { PeekState } from '../lib/commentPeek'
import { formatDate } from '../lib/markdown'
import { Person } from './Person'
import { Symbol } from './Symbol'

export function CommentPeek({ state, onShowThread }: { state: PeekState; onShowThread: (id: number) => void }) {
  const { t } = useTranslation()
  const { peek, hold, release, hide } = state
  const first = peek?.thread.comments[0]
  if (!peek || !first) return null
  const replies = peek.thread.comments.length - 1
  return (
    <div
      role="dialog"
      aria-label={t('comments.peek')}
      data-testid="comment-peek"
      data-thread={peek.thread.id}
      style={{ left: Math.max(8, peek.x), top: peek.y }}
      onMouseEnter={hold}
      onMouseLeave={release}
      // An invisible border above reaches up to the line: the way from the words onto the preview never leaves both.
      className="fixed z-30 w-72 max-w-[calc(100vw-16px)] border-t-4 border-transparent"
    >
      <div className="rounded-xl border border-ink-700 bg-ink-900 p-3 text-sm shadow-2xl">
        <div className="flex items-baseline gap-2 text-xs text-mist-500">
          <Person name={first.author} className="font-semibold text-mist-300" />
          <span>{formatDate(first.created_at)}</span>
        </div>
        <p className="mt-1 line-clamp-4 break-words whitespace-pre-wrap text-mist-200">{first.body}</p>
        <div className="mt-2 flex items-center gap-2 text-xs">
          {replies > 0 && <span className="text-mist-500">{t('comments.replies', { count: replies })}</span>}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onShowThread(peek.thread.id)
              hide()
            }}
            className="ml-auto inline-flex items-center gap-1 font-semibold text-accent-400 hover:text-accent-300"
          >
            {t('comments.toThread')}
            <Symbol name="chevronRight" className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
