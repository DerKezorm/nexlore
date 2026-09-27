/** The frame of the pages before signing in: the logo, one card, the switch for light and dark. */
import { useId, type ReactNode } from 'react'

import { Logo } from './Logo'
import { ThemeSwitcher } from './ThemeSwitcher'

export function AuthFrame({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <div className="nn-scroll flex min-h-dvh flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-5 py-4">
        <Logo withWordmark />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-10">
        <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-xl">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          {text && <p className="mt-1 text-sm text-mist-500">{text}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </main>
    </div>
  )
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  autoFocus = false,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  autoComplete?: string
  autoFocus?: boolean
  hint?: string
}) {
  // The hint describes the field; it is not part of its name.
  const hintId = useId()
  return (
    <div className="text-sm">
      <label className="block">
        <span className="font-medium">{label}</span>
        <input
          type={type}
          value={value}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-ink-700 bg-ink-850 px-3 text-sm outline-none focus:border-accent-500"
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

export function PrimaryButton({ children, busy = false, onClick, type = 'submit' }: { children: ReactNode; busy?: boolean; onClick?: () => void; type?: 'submit' | 'button' }) {
  return (
    <button
      type={type}
      disabled={busy}
      onClick={onClick}
      className="h-10 w-full rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function Problem({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p role="alert" className="rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
      {text}
    </p>
  )
}
