/** Lore, the spider of the project site: next to every answer, large on an empty page, small in the header. */
export function LoreSpider({ className = 'h-5 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 42" className={className} aria-hidden="true" focusable="false" data-lore="">
      <g fill="none" stroke="#0F766E" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15.5 23 Q9 11 3 15" />
        <path d="M14.5 26 Q6 20 1.8 25.5" />
        <path d="M14.5 29 Q6.5 29 3.5 35.5" />
        <path d="M16.5 31.5 Q11 35 10 40.5" />
        <path d="M32.5 23 Q39 11 45 15" />
        <path d="M33.5 26 Q42 20 46.2 25.5" />
        <path d="M33.5 29 Q41.5 29 44.5 35.5" />
        <path d="M31.5 31.5 Q37 35 38 40.5" />
      </g>
      <ellipse cx="24" cy="14" rx="11.5" ry="10" fill="#0D9488" />
      <g fill="#FFF8EE">
        <circle cx="24" cy="8.2" r="1.5" />
        <circle cx="20.6" cy="13.4" r="1.5" />
        <circle cx="27.4" cy="13.4" r="1.5" />
      </g>
      <path d="M24 8.2 20.6 13.4h6.8z" fill="none" stroke="#FFF8EE" strokeWidth="1" />
      <circle cx="24" cy="27" r="11.2" fill="#2CC7B4" />
      <circle cx="19.4" cy="26" r="4.6" fill="#FFFCF4" />
      <circle cx="28.6" cy="26" r="4.6" fill="#FFFCF4" />
      <circle cx="19.2" cy="26.7" r="3" fill="#10201E" />
      <circle cx="28.8" cy="26.7" r="3" fill="#10201E" />
      <circle cx="18.2" cy="25.3" r="1.05" fill="#fff" />
      <circle cx="27.8" cy="25.3" r="1.05" fill="#fff" />
      <circle cx="21.6" cy="19.6" r=".85" fill="#10201E" />
      <circle cx="26.4" cy="19.6" r=".85" fill="#10201E" />
      <ellipse cx="15.6" cy="31.2" rx="1.9" ry="1.1" fill="#F39AB6" />
      <ellipse cx="32.4" cy="31.2" rx="1.9" ry="1.1" fill="#F39AB6" />
      <path d="M22.3 32.2 Q24 33.8 25.7 32.2" fill="none" stroke="#10201E" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
