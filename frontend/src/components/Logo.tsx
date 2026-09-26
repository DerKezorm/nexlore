/** nexlore mark: three linked notes in teal, within the style of the nexapps marks. */
export function Logo({ className = 'h-8 w-8', withWordmark = false }: { className?: string; withWordmark?: boolean }) {
  // userSpaceOnUse, so the gradient runs across the whole mark instead of restarting for each stroke.
  const mark = (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="nexlore-mark" gradientUnits="userSpaceOnUse" x1="8" y1="8" x2="56" y2="56">
          <stop offset="0" stopColor="#ccfbf1" />
          <stop offset=".5" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#0a1514" />
      <rect x="2" y="2" width="60" height="60" rx="16" fill="none" stroke="url(#nexlore-mark)" strokeWidth="2.5" strokeOpacity=".55" />
      <path d="M20 42 32 22l12 20M20 42h24" fill="none" stroke="url(#nexlore-mark)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeOpacity=".7" />
      <circle cx="32" cy="22" r="5.5" fill="#2dd4bf" />
      <circle cx="20" cy="42" r="4.5" fill="url(#nexlore-mark)" />
      <circle cx="44" cy="42" r="4.5" fill="url(#nexlore-mark)" />
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
