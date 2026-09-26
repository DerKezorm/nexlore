/**
 * A note and its conflict copy side by side (design answer M1): what is equal once, what differs next to each
 * other with the changed words marked, and for each difference the choice to keep the note's version, take the
 * copy's, or keep both. Saving writes the note against the state it was read in (a change in between becomes a
 * conflict again, never an overwrite) and moves the copy to the trash.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, vaultApi, type NoteData } from '../api/client'
import { compareTexts, merge, wordDiff, type Choice, type Part } from '../lib/compare'
import { errorText } from '../lib/errors'
import { baseName } from '../lib/vault'

type Props = {
  notePath: string
  copyPath: string
  onClose: () => void
  /** Saved or the copy removed: the page reloads what it shows. */
  onDone: () => void
}

export function ConflictCompare({ notePath, copyPath, onClose, onDone }: Props) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [note, setNote] = useState<NoteData | null>(null)
  const [copy, setCopy] = useState<NoteData | null>(null)
  const [choices, setChoices] = useState<Choice[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
    let alive = true
    Promise.all([vaultApi.note(notePath), vaultApi.note(copyPath)])
      .then(([a, b]) => {
        if (!alive) return
        setNote(a)
        setCopy(b)
      })
      .catch((error) => alive && setProblem(error instanceof ApiError ? error.code : 'internal_error'))
    return () => {
      alive = false
    }
  }, [notePath, copyPath])

  const rows = useMemo(() => (note && copy ? compareTexts(note.content, copy.content) : []), [note, copy])
  const changes = rows.filter((row) => row.kind === 'change').length
  const eol = note?.content.includes('\r\n') ? '\r\n' : '\n'

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
      onDone()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  const saveAndRemove = () =>
    run(async () => {
      if (!note) return
      const text = merge(rows, choices, eol)
      if (text !== note.content) {
        const result = await vaultApi.save(note.path, text, note.hash)
        if (result.conflict) throw new ApiError(409, 'changed_meanwhile')
      }
      await vaultApi.remove(copyPath)
    })

  let changeIndex = -1
  return (
    <dialog
      ref={dialog}
      aria-labelledby="compare-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className="m-auto h-[min(90vh,60rem)] w-[min(80rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-950 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-ink-700 px-5 py-3">
          <h2 id="compare-title" className="flex-1 text-base font-semibold text-mist-100">{t('compare.title')}</h2>
          <span className="text-xs text-mist-500">{t('compare.changes', { count: changes })}</span>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-full px-3 py-1 text-sm text-mist-400 hover:bg-ink-850">
            {t('common.cancel')}
          </button>
        </header>
        <div className="grid grid-cols-2 gap-4 border-b border-ink-700/60 px-5 py-2 text-xs text-mist-500">
          <div>
            <span className="font-semibold text-mist-300">{t('compare.note')}</span> · {baseName(notePath)}
          </div>
          <div>
            <span className="font-semibold text-mist-300">{t('compare.copy')}</span> · {baseName(copyPath)}
          </div>
        </div>
        <div className="nn-scroll min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {!note || !copy ? (
            <p className="text-sm text-mist-500">{problem ? errorText(problem) : t('common.loading')}</p>
          ) : changes === 0 ? (
            <p className="text-sm text-mist-400">{t('compare.equal')}</p>
          ) : (
            rows.map((row, index) => {
              if (row.kind === 'same') {
                return (
                  <div key={index} className="grid grid-cols-2 gap-4 py-1 font-mono text-xs whitespace-pre-wrap text-mist-600">
                    <div>{row.left.trimEnd()}</div>
                    <div>{row.right.trimEnd()}</div>
                  </div>
                )
              }
              const at = ++changeIndex
              const choice = choices[at] ?? 'left'
              const left = row.left.join('').trimEnd()
              const right = row.right.join('').trimEnd()
              const words = wordDiff(left, right)
              const set = (value: Choice) => setChoices((list) => Object.assign([...list], { [at]: value }))
              return (
                <div key={index} className="my-2 rounded-xl border border-warn-500/30 bg-warn-500/5 p-2">
                  <div className="grid grid-cols-2 gap-4 font-mono text-xs whitespace-pre-wrap">
                    <Side parts={words.left} empty={t('compare.nothing')} chosen={choice !== 'right'} tone="left" />
                    <Side parts={words.right} empty={t('compare.nothing')} chosen={choice !== 'left'} tone="right" />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('compare.choose')}>
                    {(['left', 'right', 'both'] as Choice[]).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={choice === value}
                        onClick={() => set(value)}
                        className={
                          'rounded-full border px-3 py-0.5 text-xs ' +
                          (choice === value ? 'border-accent-500 bg-accent-500 font-semibold text-on-accent' : 'border-ink-700 text-mist-400 hover:text-mist-100')
                        }
                      >
                        {t(`compare.take.${value}`)}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-ink-700 px-5 py-3">
          {problem && note && <p className="flex-1 text-sm text-bad-500">{errorText(problem)}</p>}
          <p className="flex-1 text-xs text-mist-500">{t('compare.hint')}</p>
          <button type="button" disabled={busy || !note} onClick={() => void run(() => vaultApi.remove(copyPath).then(() => undefined))} className="rounded-full border border-ink-700 px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850 disabled:opacity-40">
            {t('compare.keepNote')}
          </button>
          <button type="button" disabled={busy || !note} onClick={() => void saveAndRemove()} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40">
            {t('compare.save')}
          </button>
        </footer>
      </div>
    </dialog>
  )
}

function Side({ parts, empty, chosen, tone }: { parts: Part[]; empty: string; chosen: boolean; tone: 'left' | 'right' }) {
  const mark = tone === 'left' ? 'bg-bad-500/25 text-mist-100' : 'bg-ok-500/25 text-mist-100'
  return (
    <div className={'rounded-lg p-1.5 ' + (chosen ? 'bg-ink-900 text-mist-200' : 'text-mist-600 line-through decoration-mist-600/50')}>
      {parts.length === 0 || (parts.length === 1 && !parts[0].text) ? (
        <span className="text-mist-600 italic">{empty}</span>
      ) : (
        parts.map((part, index) =>
          part.changed ? (
            <mark key={index} className={'rounded-sm ' + mark}>
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )
      )}
    </div>
  )
}
