/**
 * The symbols in one place, like in Nexview, nexcrate, nexpulse and nextrmnl: 24x24,
 * stroke instead of fill, `currentColor`.
 */

type Path = { d: string; fill?: boolean }

const SYMBOLS = {
  graph: [{ d: 'M6 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9 20.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z' }, { d: 'M7.8 6.2l8.4 1.6M7 7.3l1.4 9.3M16.6 9.6l-6.2 7.6' }],
  note: [{ d: 'M6.5 3.5h7l4 4v13h-11z' }, { d: 'M13.5 3.5v4h4M9 12.5h6M9 16h4' }],
  files: [{ d: 'M8.5 7.5h11v12h-11z' }, { d: 'M15.5 7.5v-3h-11v12h4' }],
  settings: [{ d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }, { d: 'M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z' }],
  search: [{ d: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z' }, { d: 'M20 20l-4-4' }],
  folder: [{ d: 'M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5V7Z' }],
  space: [{ d: 'M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z' }, { d: 'M4 8l8 4.5L20 8M12 12.5v8' }],
  chevronRight: [{ d: 'M9.5 6l6 6-6 6' }],
  chevronDown: [{ d: 'M6 9.5l6 6 6-6' }],
  plus: [{ d: 'M12 5v14M5 12h14' }],
  minus: [{ d: 'M5 12h14' }],
  fit: [{ d: 'M4.5 9.5v-5h5M19.5 9.5v-5h-5M4.5 14.5v5h5M19.5 14.5v5h-5' }],
  close: [{ d: 'M6 6l12 12M18 6 6 18' }],
  lock: [{ d: 'M5 10.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1Z' }, { d: 'M8 10.5V8a4 4 0 1 1 8 0v2.5' }],
  sparkle: [{ d: 'M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8L12 3.5Z' }, { d: 'M18.5 16v4M16.5 18h4' }],
  users: [{ d: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z' }, { d: 'M2.5 20a6.5 6.5 0 0 1 13 0' }, { d: 'M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14a6.5 6.5 0 0 1 3.5 6' }],
  link: [{ d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1' }, { d: 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }],
  backlink: [{ d: 'M9.5 7.5 5 12l4.5 4.5' }, { d: 'M5 12h9a5 5 0 0 0 5-5V5' }],
  pencil: [{ d: 'M15.5 5.5l3 3L8 19H5v-3L15.5 5.5Z' }],
  eye: [{ d: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' }, { d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' }],
  eyeOff: [{ d: 'M4 4l16 16' }, { d: 'M10 5.8c.6-.2 1.3-.3 2-.3 6 0 9.5 6.5 9.5 6.5s-.9 1.7-2.6 3.4M6.5 7.3C4 9 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.5 0 2.9-.4 4.1-1' }],
  image: [{ d: 'M4 5h16v14H4z' }, { d: 'M4 16l5-5 4 4 2-2 5 5' }, { d: 'M15.5 9.5h.01' }],
  pdf: [{ d: 'M6.5 3.5h7l4 4v13h-11z' }, { d: 'M13.5 3.5v4h4' }, { d: 'M9 15.5h6M9 12.5h3' }],
  file: [{ d: 'M6.5 3.5h7l4 4v13h-11z' }, { d: 'M13.5 3.5v4h4' }],
  clip: [{ d: 'M19 11.5l-7.2 7.2a4.5 4.5 0 0 1-6.4-6.4L13 4.7a3 3 0 0 1 4.2 4.2l-7.5 7.5a1.5 1.5 0 0 1-2.1-2.1l6.8-6.8' }],
  upload: [{ d: 'M12 16V4M6.5 9.5 12 4l5.5 5.5' }, { d: 'M4 16.5V20h16v-3.5' }],
  download: [{ d: 'M12 4v12M6.5 10.5 12 16l5.5-5.5' }, { d: 'M4 16.5V20h16v-3.5' }],
  globe: [{ d: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z' }, { d: 'M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5Z' }],
  plug: [{ d: 'M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0v-3Z' }, { d: 'M12 16v4.5' }],
  key: [{ d: 'M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z' }, { d: 'M12 11h8.5M17.5 11v3M20.5 11v2' }],
  shield: [{ d: 'M12 3.5 19.5 6v5.5c0 4.5-3.2 8-7.5 9-4.3-1-7.5-4.5-7.5-9V6L12 3.5Z' }, { d: 'M9 12l2 2 4-4' }],
  check: [{ d: 'M5 12.5l4.5 4.5L19 7.5' }],
  info: [{ d: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z' }, { d: 'M12 11v5.5M12 7.8v.2' }],
  sidebar: [{ d: 'M4 5h16v14H4z' }, { d: 'M9.5 5v14' }],
  open: [{ d: 'M14 4.5h5.5V10M19.5 4.5 10.5 13.5' }, { d: 'M16.5 13.5v5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1h5' }],
} satisfies Record<string, Path[]>

export type SymbolName = keyof typeof SYMBOLS

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
