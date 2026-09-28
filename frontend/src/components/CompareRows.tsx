/**
 * Two texts side by side, block by block, the changed words marked: an AI draft next to the note (MCP), an AI result
 * next to the text it came from (the editor's AI).
 */
import { useMemo } from 'react'

import { compareTexts, wordDiff, type Part } from '../lib/compare'

function Words({ parts, tone }: { parts: Part[]; tone: 'old' | 'new' }) {
  const mark = tone === 'old' ? 'bg-bad-500/20 text-bad-400' : 'bg-accent-500/20 text-accent-300'
  return (
    <div>
      {parts.map((part, index) => (
        <span key={index} className={part.changed ? mark : ''}>
          {part.text}
        </span>
      ))}
    </div>
  )
}

export function CompareRows({ left, right, testId }: { left: string; right: string; testId?: string }) {
  const rows = useMemo(() => compareTexts(left, right), [left, right])
  return (
    <div className="nn-scroll min-h-0 flex-1 overflow-y-auto px-5 py-3" data-testid={testId}>
      {rows.map((row, index) => {
        if (row.kind === 'same') {
          return (
            <div key={index} className="grid grid-cols-2 gap-4 py-1 font-mono text-xs whitespace-pre-wrap text-mist-600">
              <div>{row.left.trimEnd()}</div>
              <div>{row.right.trimEnd()}</div>
            </div>
          )
        }
        const words = wordDiff(row.left.join('').trimEnd(), row.right.join('').trimEnd())
        return (
          <div key={index} className="my-2 grid grid-cols-2 gap-4 rounded-xl border border-accent-500/30 bg-accent-500/5 p-2 font-mono text-xs whitespace-pre-wrap">
            <Words parts={words.left} tone="old" />
            <Words parts={words.right} tone="new" />
          </div>
        )
      })}
    </div>
  )
}
