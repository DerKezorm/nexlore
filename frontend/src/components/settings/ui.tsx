/**
 * The pieces nexlore's own settings cards are built from, all from the ui kit (`vendor/nexui`, plan "Einstellungen":
 * "Gleiches Aussehen kommt nur aus dem Bausatz"): the card (`Card`, with its `id` as `data-card`), on or off as a tick
 * (`CheckboxRow`, never a switch), fields (`Field`, `SelectField`), buttons in three kinds and two sizes, always with a
 * symbol and words (`Button`), a value to copy (`CopyRow`). The names stay those nexlore's cards used before, so a card
 * changes its look, not its code.
 */
import {
  Bell,
  BookOpen,
  Calendar,
  Check,
  Code,
  Folder,
  Globe,
  HardDrive,
  History,
  Home,
  Info,
  Key,
  Keyboard,
  Link,
  Mail,
  Paperclip,
  Pencil,
  Plug,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { Button as KitButton, Card as KitCard, CheckboxRow, CopyRow, Field, SelectField, type IconLike } from '../../vendor/nexui'
import type { SymbolName } from '../Symbol'

/** The symbols nexlore's cards named, as the kit's (lucide) icons. */
const SYMBOL_ICON: Partial<Record<SymbolName, LucideIcon>> = {
  bell: Bell,
  book: BookOpen,
  calendar: Calendar,
  clip: Paperclip,
  code: Code,
  folder: Folder,
  globe: Globe,
  hardDrive: HardDrive,
  history: History,
  home: Home,
  info: Info,
  key: Key,
  keyboard: Keyboard,
  link: Link,
  mail: Mail,
  pencil: Pencil,
  phone: Smartphone,
  plug: Plug,
  refresh: RefreshCw,
  shield: ShieldCheck,
  space: Folder,
  sparkle: Sparkles,
  trash: Trash2,
  upload: Upload,
  users: Users,
}

export function Card({ symbol, icon, title, text, children, id, testId }: {
  symbol?: SymbolName
  icon?: IconLike
  title: string
  text?: ReactNode
  children?: ReactNode
  id?: string
  testId?: string
}) {
  return (
    <KitCard id={id} icon={icon ?? (symbol && SYMBOL_ICON[symbol]) ?? Info} title={title} subtitle={text} testId={testId}>
      {children}
    </KitCard>
  )
}

/** On or off with its name and a line of explanation: a tick, never a switch. */
export function Toggle({ label, hint, checked, onChange, disabled = false, testId }: {
  label: string
  hint?: ReactNode
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  testId?: string
}) {
  return <CheckboxRow label={label} hint={hint} checked={checked} onChange={onChange} disabled={disabled} testId={testId} />
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
  action,
  testId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  hint?: ReactNode
  className?: string
  autoComplete?: string
  /** The field's own button, level with the field (`Field action`). */
  action?: ReactNode
  testId?: string
}) {
  return (
    <div className={className}>
      <Field
        label={label}
        value={value}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        hints={hint ? [hint] : []}
        action={action}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

export function Select<T extends string>({ label, value, options, onChange, className = '', hint }: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  className?: string
  hint?: ReactNode
}) {
  return (
    <div className={className}>
      <SelectField label={label} value={value} options={options} hints={hint ? [hint] : []} onChange={(event) => onChange(event.target.value as T)} />
    </div>
  )
}

/** A button of the kit: `primary` (at most one per card), `danger` for what removes or ends something, else
 * secondary; `small` is the kit's `sm` (rows, lists, tables). Always a symbol and words. */
export function Button({
  children,
  onClick,
  primary = false,
  danger = false,
  busy = false,
  type = 'button',
  small = false,
  label,
  icon,
  disabled = false,
  testId,
}: {
  children: ReactNode
  onClick?: () => void
  primary?: boolean
  danger?: boolean
  busy?: boolean
  type?: 'button' | 'submit'
  small?: boolean
  label?: string
  icon?: IconLike
  disabled?: boolean
  testId?: string
}) {
  return (
    <KitButton
      kind={primary ? 'primary' : danger ? 'danger' : 'secondary'}
      size={small ? 'sm' : 'md'}
      icon={icon ?? (danger ? Trash2 : Check)}
      type={type}
      busy={busy}
      disabled={disabled}
      aria-label={label}
      testId={testId}
      onClick={onClick}
    >
      {children}
    </KitButton>
  )
}

export function Feedback({ problem, done }: { problem: string | null; done?: string | null }) {
  return (
    <div aria-live="polite">
      {problem && <p className="m-0 text-sm text-[var(--nexui-danger)]">{problem}</p>}
      {done && <p className="m-0 text-sm text-[var(--nexui-ok)]">{done}</p>}
    </div>
  )
}

/** A link that is shown once, to copy (`CopyRow` of the kit). */
export function CopyLink({ link, label }: { link: string; label: string }) {
  return <CopyRow value={link} label={label} />
}
