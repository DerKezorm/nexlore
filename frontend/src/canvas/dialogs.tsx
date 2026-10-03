/**
 * The canvas's small dialogs: picking a note or a file of the space to lay on it, and asking for one line (an address,
 * a group's name, a line's label). Keyboard as everywhere in nexlore (`useDialogFocus`).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { vaultApi, type Found } from '../api/client'
import { Symbol } from '../components/Symbol'
import { useDialogFocus } from '../lib/dialogFocus'

const FRAME = 'fixed inset-0 z-50 grid place-items-start justify-center bg-black/50 px-4 pt-[12vh]'
const BOX = 'w-full max-w-lg overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl'

/** A note or a file of `space` to lay on the canvas; `files`: any file, not only notes. */
export function PickDialog({ space, files, onPick, onClose }: { space: string; files: boolean; onPick: (path: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const close = useDialogFocus(box, onClose)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ path: string; title: string }[]>([])
  const [chosen, setChosen] = useState(0)
  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      const ask = files
        ? vaultApi.attachments(space).then((found) =>
            found.items
              .filter((item) => item.path.toLowerCase().includes(query.trim().toLowerCase()))
              .slice(0, 30)
              .map((item) => ({ path: item.path, title: item.path.split('/').pop() ?? item.path })),
          )
        : vaultApi.find(query, undefined, 30).then((found: Found[]) => found.map((item) => ({ path: item.path, title: item.title })))
      ask.then((list) => alive && (setHits(list), setChosen(0)), () => alive && setHits([]))
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query, space, files])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (hits[chosen]) onPick(hits[chosen].path)
  }
  return (
    <div className={FRAME} onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={t(files ? 'canvas.pickFile' : 'canvas.pickNote')} className={BOX}>
        <form onSubmit={submit}>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') setChosen((at) => Math.min(at + 1, Math.max(hits.length - 1, 0)))
              if (event.key === 'ArrowUp') setChosen((at) => Math.max(at - 1, 0))
            }}
            placeholder={t(files ? 'canvas.pickFile' : 'canvas.pickNote')}
            aria-label={t(files ? 'canvas.pickFile' : 'canvas.pickNote')}
            className="w-full border-b border-ink-700 bg-transparent px-4 py-3 text-[15px] text-mist-100 outline-none"
          />
        </form>
        <ul role="listbox" aria-label={t('canvas.found')} className="max-h-[50vh] overflow-y-auto py-1">
          {hits.map((hit, index) => (
            <li key={hit.path} role="option" aria-selected={index === chosen}>
              <button
                type="button"
                onClick={() => onPick(hit.path)}
                onMouseEnter={() => setChosen(index)}
                className={'flex w-full items-baseline gap-2 px-4 py-2 text-left text-sm ' + (index === chosen ? 'bg-accent-500/10 text-mist-100' : 'text-mist-300')}
              >
                <Symbol name={files ? 'file' : 'note'} className="h-3.5 w-3.5 shrink-0 self-center opacity-70" />
                <span className="truncate">{hit.title}</span>
                {/* Where it lies: its folder, with the space's name in front when it is another space. */}
                <span className="ml-auto truncate text-xs text-mist-500">{hit.path.split('/').slice(hit.path.startsWith(space + '/') ? 1 : 0, -1).join(' / ')}</span>
              </button>
            </li>
          ))}
          {!hits.length && <li className="px-4 py-3 text-sm text-mist-500">{t('canvas.nothingFound')}</li>}
        </ul>
        <p className="border-t border-ink-700 px-4 py-2 text-xs text-mist-500">{files ? t('canvas.onlyThisSpace', { space }) : t('canvas.everySpace')}</p>
      </div>
    </div>
  )
}

/** One line to type: an address, a name, a label. Empty is allowed where `allowEmpty` (a label taken away). */
export function AskDialog({
  title,
  label,
  initial = '',
  allowEmpty = false,
  onDone,
  onClose,
}: {
  title: string
  label: string
  initial?: string
  allowEmpty?: boolean
  onDone: (value: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const close = useDialogFocus(box, onClose)
  const [value, setValue] = useState(initial)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (value.trim() || allowEmpty) onDone(value.trim())
  }
  return (
    <div className={FRAME} onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="nl-ask-title" className={BOX + ' p-5'}>
        <form onSubmit={submit} className="space-y-3">
          <h2 id="nl-ask-title" className="text-base font-semibold">
            {title}
          </h2>
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label={label}
            placeholder={label}
            className="w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-mist-100 outline-none focus:border-accent-500"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="rounded-full border border-ink-600 px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={!value.trim() && !allowEmpty} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-40">
              {t('canvas.done')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
