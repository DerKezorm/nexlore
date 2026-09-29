/**
 * The symbol of a space or folder: one of the own (`lib/symbols`) or one of Lucide ("l:<name>", `lib/lucide`), whose
 * data comes on first use. Until it is there, the place stays empty in the size of the symbol.
 */
import { lucidePaths, useLucide, isLucide } from '../lib/lucide'
import { SYMBOLS } from '../lib/symbols'
import { Symbol, type SymbolName } from './Symbol'

export function LookIcon({ name, className = 'h-4 w-4' }: { name: string; className?: string }) {
  const lucide = isLucide(name)
  useLucide(lucide)
  if (!lucide) return name in SYMBOLS ? <Symbol name={name as SymbolName} className={className} /> : null
  const paths = lucidePaths(name) ?? []
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  )
}
