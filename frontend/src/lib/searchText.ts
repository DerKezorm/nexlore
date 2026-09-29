/**
 * The search text of the search page, as chips: each operator or word a piece that can be taken out, and the filters
 * beside the results write into the same text (so a search can always be read, copied and changed as text).
 */

const TOKEN = /-?[\w-]+:"[^"]*"|-?"[^"]*"|-?\[[^\]]*\]|\S+/g

export function pieces(query: string): string[] {
  return query.match(TOKEN) ?? []
}

export function without(query: string, piece: string): string {
  const list = pieces(query)
  const at = list.indexOf(piece)
  if (at >= 0) list.splice(at, 1)
  return list.join(' ')
}

/** The query with `piece` in it or out of it. */
export function toggled(query: string, piece: string): string {
  const list = pieces(query)
  return list.includes(piece) ? without(query, piece) : [...list, piece].join(' ')
}

/** The query with the one piece of a kind (`changed:`) replaced, or taken out when `piece` is null. */
export function replaced(query: string, prefix: string, piece: string | null): string {
  const list = pieces(query).filter((item) => !item.toLowerCase().startsWith(prefix))
  if (piece) list.push(piece)
  return list.join(' ')
}

/** A value for an operator: in quotes when it has a blank. */
export function operator(name: string, value: string): string {
  return /\s/.test(value) ? `${name}:"${value}"` : `${name}:${value}`
}
