/** Small pieces the settings cards share: the card, a switch row, fields, buttons. */
import { useId, useState, type ReactNode } from 'react'

import { Symbol, type SymbolName } from '../Symbol'

export function Card({ symbol, title, text, children, id }: { symbol: SymbolName; title: string; text?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="rounded-2xl border border-ink-700 bg-ink-900 p-5">
      <div className="mb-4 flex gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/12 text-accent-400">
          <Symbol name={symbol} />
        </span>
        <div>
          <h2 id={id ? `${id}-title` : undefined} className="font-semibold">
            {title}
          </h2>
          {text && <p className="text-sm text-mist-500">{text}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

/** A switch with its name and a line of explanation; the whole row is the label. */
export function Toggle({ label, hint, checked, onChange, disabled = false }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const hintId = useId()
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
      <span>
        <span className="font-medium">{label}</span>
        {hint && (
          <span id={hintId} className="block text-xs text-mist-500">
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5 shrink-0 accent-accent-500"
      />
    </label>
  )
}

export function Input({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  className = '',
  autoComplete = 'off',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  hint?: string
  className?: string
  autoComplete?: string
}) {
  const hintId = useId()
  return (
    <div className={'text-sm ' + className}>
      <label className="block">
        <span className="text-xs font-medium text-mist-400">{label}</span>
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-3 text-sm outline-none focus:border-accent-500"
        />
      </label>
      {hint && (
        <span id={hintId} className="mt-1 block text-xs text-mist-500">
          {hint}
        </span>
      )}
    </div>
  )
}

export function Select<T extends string>({ label, value, options, onChange, className = '' }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; className?: string }) {
  return (
    <label className={'block text-sm ' + className}>
      <span className="text-xs font-medium text-mist-400">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="mt-1 h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Button({
  children,
  onClick,
  primary = false,
  danger = false,
  busy = false,
  type = 'button',
  small = false,
  label,
}: {
  children: ReactNode
  onClick?: () => void
  primary?: boolean
  danger?: boolean
  busy?: boolean
  type?: 'button' | 'submit'
  small?: boolean
  label?: string
}) {
  const look = primary
    ? 'bg-accent-500 font-semibold text-on-accent hover:bg-accent-400'
    : danger
      ? 'border border-ink-700 text-mist-300 hover:border-bad-500/50 hover:text-bad-500'
      : 'border border-ink-700 text-mist-300 hover:bg-ink-850'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-full ${small ? 'px-2.5 py-0.5 text-xs' : 'px-3.5 py-1.5 text-sm'} ${look} disabled:opacity-50`}
    >
      {children}
    </button>
  )
}

export function Feedback({ problem, done }: { problem: string | null; done?: string | null }) {
  return (
    <div aria-live="polite">
      {problem && <p className="mt-3 text-sm text-bad-500">{problem}</p>}
      {done && <p className="mt-3 text-sm text-ok-500">{done}</p>}
    </div>
  )
}

/** A link that is shown once: the field to copy from, and the button that copies. */
export function CopyLink({ link, label }: { link: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-xl border border-accent-500/40 bg-accent-500/10 p-2">
      <input readOnly value={link} aria-label={label} onFocus={(event) => event.target.select()} className="min-w-0 flex-1 bg-transparent px-2 font-mono text-xs outline-none" />
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(link).then(() => setCopied(true))
        }}
        className="shrink-0 rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-on-accent hover:bg-accent-400"
      >
        {copied ? '✓' : label}
      </button>
    </div>
  )
}
