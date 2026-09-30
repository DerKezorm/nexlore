/**
 * Quick capture: a thought into the inbox of a space, without opening a note: the space of the open note, else the
 * account's main space (Settings, General). Ctrl+Enter keeps it; the box stays open and empty for the next one, Escape closes it.
 *
 * Opened from the palette, by a long press (or the right button) on "+", and by sharing to the installed app
 * (`/capture?title=…&text=…&url=…`, the manifest's share target).
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { ApiError, captureApi } from '../api/client'
import { stamp } from '../lib/capture'
import { homeSpace, openSpaceOf } from '../lib/everyday'
import { useAuth } from '../state/auth'
import { showModalOnce } from '../lib/dialog'
import { errorText } from '../lib/errors'
import { noteUrl } from '../lib/vault'
import { useStore } from '../state/store'

export function CaptureDialog({ text: given = '', onClose }: { text?: string; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const dialog = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const { spaces } = useStore()
  const writable = spaces.filter((item) => item.role === 'write' || item.role === 'manage').map((item) => item.name)
  const { me } = useAuth()
  const location = useLocation()
  // Chosen here for this entry only; until then the open space, else the main space (both may load after opening).
  const [chosen, setChosen] = useState<string | null>(null)
  const fallback = homeSpace(spaces, me?.appearance?.home_space, openSpaceOf(location.pathname))?.name ?? ''
  const space = chosen !== null && writable.includes(chosen) ? chosen : fallback
  const [text, setText] = useState(given)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [kept, setKept] = useState<{ path: string; space: string } | null>(null)

  useEffect(() => {
    showModalOnce(dialog.current)
    field.current?.focus()
  }, [])

  const keep = async () => {
    if (!text.trim() || !space || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const answer = await captureApi.put(space, text, stamp(new Date()), i18n.language)
      setKept({ path: answer.path, space })
      setText('')
      field.current?.focus()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="capture-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(34rem,calc(100vw-1.5rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
      data-testid="capture-dialog"
    >
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault()
          void keep()
        }}
      >
        <h2 id="capture-title" className="text-lg font-semibold">
          {t('capture.title')}
        </h2>
        <textarea
          ref={field}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setKept(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void keep()
            }
          }}
          rows={4}
          aria-label={t('capture.text')}
          placeholder={t('capture.placeholder')}
          className="w-full resize-y rounded-xl border border-ink-700 bg-ink-950 p-3 text-sm text-mist-100 outline-none placeholder:text-mist-600 focus:border-accent-500"
        />
        <label className="flex items-center gap-2 text-sm text-mist-400">
          {t('capture.space')}
          <select
            value={space}
            onChange={(event) => setChosen(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-mist-100 outline-none focus:border-accent-500"
          >
            {writable.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {!writable.length && <p className="text-sm text-warn-500">{t('capture.noSpace')}</p>}
        {problem && (
          <p role="alert" className="text-sm text-warn-500">
            {problem === 'note_locked' ? t('capture.locked') : errorText(problem)}
          </p>
        )}
        {kept && (
          <p role="status" className="text-sm text-mist-400">
            {t('capture.kept', { space: kept.space })}{' '}
            <button
              type="button"
              className="text-accent-400 underline-offset-2 hover:underline"
              onClick={() => {
                onClose()
                navigate(noteUrl(kept.path))
              }}
            >
              {t('capture.open')}
            </button>
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-mist-600">{t('capture.keys')}</span>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-mist-400 hover:bg-ink-850 hover:text-mist-100">
            {kept ? t('capture.done') : t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!text.trim() || !space || busy}
            className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40"
          >
            {t('capture.keep')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
