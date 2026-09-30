/**
 * A name asked for in a small modal `<dialog>` (the group of a favorite): the field focused, Enter keeps it, Escape
 * or the backdrop cancels. Names already in use are offered as the field is typed into.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  title: string
  label: string
  initial?: string
  suggestions?: string[]
  maxLength?: number
  onSave: (name: string) => void
  onCancel: () => void
}

export function NameDialog({ title, label, initial = '', suggestions = [], maxLength = 80, onSave, onCancel }: Props) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(initial)
  const titleId = useId()
  const listId = useId()

  useEffect(() => {
    dialog.current?.showModal()
    field.current?.focus()
  }, [])

  const save = () => {
    const clean = name.split(/\s+/).filter(Boolean).join(' ')
    if (clean) onSave(clean)
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      onClick={(event) => event.target === dialog.current && onCancel()}
      className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <form
        className="p-5"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <h2 id={titleId} className="text-base font-semibold text-mist-100">{title}</h2>
        <label className="mt-3 block text-sm text-mist-400">
          {label}
          <input
            ref={field}
            value={name}
            maxLength={maxLength}
            list={suggestions.length ? listId : undefined}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm text-mist-100 outline-none focus:border-accent-500"
          />
        </label>
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-full px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={!name.trim()} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50">
            {t('common.save')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
