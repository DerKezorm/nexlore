/**
 * A note named by the minute it was made (Obsidian's "Unique note creator"): `202609301245`, in the folder a new
 * note goes to. Two in the same minute: the server numbers the second (`202609301245 2`).
 */

const two = (n: number) => String(n).padStart(2, '0')

/** The name for a note made at `when`, in local time: year, month, day, hour, minute. */
export function zettelName(when: Date): string {
  return `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}${two(when.getHours())}${two(when.getMinutes())}`
}
