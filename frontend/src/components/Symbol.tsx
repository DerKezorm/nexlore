/** A symbol of `lib/symbols` as an inline SVG in the text colour. */

import { SYMBOLS, type Path, type SymbolName } from '../lib/symbols'

export type { SymbolName }

export function Symbol({ name, className = 'h-4 w-4' }: { name: SymbolName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      {(SYMBOLS[name] as Path[]).map((path, index) => (
        <path
          key={index}
          d={path.d}
          fill={path.fill ? 'currentColor' : 'none'}
          stroke={path.fill ? 'none' : 'currentColor'}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}
