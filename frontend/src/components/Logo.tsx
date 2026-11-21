/*
 * The nexlore mark: a mine cart (Lore) carrying a little web of knowledge, a play on nex*lore*. The source of every
 * version is nexapps/icons-vergleich/neu.py; the same shape is in public/logo.svg (favicon) and
 * scripts/app-icons.mjs (home screen). Change it there too.
 *
 * The colours come from styles/index.css (--nl-logo-…) and follow the app's mode: a white tile in light mode, a
 * near-black one in dark mode.
 */
export function Logo({ className = 'h-8 w-8', withWordmark = false }: { className?: string; withWordmark?: boolean }) {
  // userSpaceOnUse, so the gradient runs across the whole mark instead of restarting for each stroke.
  const mark = (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="nexlore-mark" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="54" y2="54">
          <stop offset="0" style={{ stopColor: 'var(--nl-logo-verlauf-1)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--nl-logo-verlauf-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--nl-logo-verlauf-3)' }} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" style={{ fill: 'var(--nl-logo-grund)' }} />
      <rect
        x="2.75"
        y="2.75"
        width="58.5"
        height="58.5"
        rx="15.3"
        fill="none"
        strokeWidth="1.5"
        style={{ stroke: 'var(--nl-logo-rand)', strokeOpacity: 'var(--nl-logo-rand-deckung)' }}
      />
      <g transform="translate(0 -1.5)">
      <path d="M20.5 25 30 16 42 21.5M30 16 34 25.5" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--nl-logo-akzent)' }} />
      <circle cx="20.5" cy="25" r="3.6" strokeWidth="1.8" style={{ fill: 'var(--nl-logo-akzent)', stroke: 'var(--nl-logo-grund)' }} />
      <circle cx="42" cy="21.5" r="3.6" strokeWidth="1.8" style={{ fill: 'var(--nl-logo-akzent)', stroke: 'var(--nl-logo-grund)' }} />
      <circle cx="34" cy="25.5" r="3.4" strokeWidth="1.8" style={{ fill: 'var(--nl-logo-akzent)', stroke: 'var(--nl-logo-grund)' }} />
      <circle cx="30" cy="16" r="4.6" strokeWidth="1.8" style={{ fill: 'var(--nl-logo-akzent)', stroke: 'var(--nl-logo-grund)' }} />
      <path d="M15 28.5H49L45.5 44H18.5Z" stroke="url(#nexlore-mark)" strokeWidth="4.2" strokeLinejoin="round" style={{ fill: 'var(--nl-logo-grund)' }} />
      <path d="M12.5 28.5H51.5" stroke="url(#nexlore-mark)" strokeWidth="4.2" strokeLinecap="round"/>
      <path d="M17.6 36.2H46.4" stroke="url(#nexlore-mark)" strokeWidth="2.6" strokeOpacity=".6"/>
      <circle cx="22" cy="40" r="1.3" fill="url(#nexlore-mark)" opacity=".6"/>
      <circle cx="42" cy="40" r="1.3" fill="url(#nexlore-mark)" opacity=".6"/>
      <circle cx="22" cy="32.4" r="1.3" fill="url(#nexlore-mark)" opacity=".6"/>
      <circle cx="42" cy="32.4" r="1.3" fill="url(#nexlore-mark)" opacity=".6"/>
      <path d="M11 52.5H53" stroke="url(#nexlore-mark)" strokeWidth="2.6" strokeLinecap="round" strokeOpacity=".55"/>
      <circle cx="24.5" cy="47" r="4.4" fill="url(#nexlore-mark)" strokeWidth="2" style={{ stroke: 'var(--nl-logo-grund)' }} />
      <circle cx="39.5" cy="47" r="4.4" fill="url(#nexlore-mark)" strokeWidth="2" style={{ stroke: 'var(--nl-logo-grund)' }} />
      </g>
    </svg>
  )
  if (!withWordmark) return mark
  return (
    <span className="flex items-center gap-2.5">
      {mark}
      <span className="hidden text-lg font-bold tracking-tight sm:inline">
        NEX<span className="text-accent-500">LORE</span>
      </span>
    </span>
  )
}
