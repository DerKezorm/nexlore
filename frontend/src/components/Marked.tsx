/**
 * A text with hits marked by the server with two control characters (\u0002 … \u0003): split here and shown as
 * <mark>, never inserted as HTML.
 */
const HIT_START = '\u0002'
const HIT_END = '\u0003'

export function Marked({ text }: { text: string }) {
  const parts: { text: string; hit: boolean }[] = []
  text.split(HIT_START).forEach((piece, position) => {
    const end = piece.indexOf(HIT_END)
    // Everything before the first start mark is plain text; after a start mark, up to its end mark is the hit.
    if (position === 0 || end < 0) {
      if (piece) parts.push({ text: piece.replaceAll(HIT_END, ''), hit: false })
      return
    }
    parts.push({ text: piece.slice(0, end), hit: true })
    const rest = piece.slice(end + 1).replaceAll(HIT_END, '')
    if (rest) parts.push({ text: rest, hit: false })
  })
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded bg-accent-500/25 px-0.5 text-mist-100">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}
