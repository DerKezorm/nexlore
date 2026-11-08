/** A pasted picture's name as the server makes it from the pattern (`services/attachments._fill`), for the example. */
export function pastedExample(pattern: string, note: string, now: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
  const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
  return pattern.trim().replace(/\{(note|date|time|n)(?::([1-9]))?\}/g, (_all, word: string, width?: string) =>
    word === 'note' ? note : word === 'date' ? date : word === 'time' ? time : '1'.padStart(Number(width ?? 1), '0'),
  )
}
