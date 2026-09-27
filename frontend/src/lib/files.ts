/**
 * Files other than notes, as the interface needs them: what kind a file is (by its ending: the server decides by
 * content what it hands out as what), and where a relative link in a note points.
 */

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'other'

const KINDS: [RegExp, FileKind][] = [
  [/\.(png|jpe?g|gif|webp|avif|bmp)$/i, 'image'],
  [/\.(mp4|mov|m4v|webm)$/i, 'video'],
  [/\.(mp3|m4a|ogg|oga|opus|wav|flac)$/i, 'audio'],
  [/\.pdf$/i, 'pdf'],
]

export function fileKind(path: string): FileKind {
  return KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? 'other'
}

export const isNotePath = (path: string) => /\.md$/i.test(path)

/** Endings of files that sit beside notes. Any other `.x` is part of a note's name (`[[Release 2.5]]`, `[[v1.2]]`). */
const FILE_ENDINGS = new Set(
  (
    'png jpg jpeg gif webp avif bmp svg heic heif tif tiff ico mp4 mov m4v webm mkv avi mp3 m4a ogg oga opus wav flac ' +
    'aac pdf txt csv tsv json xml yaml yml log html htm docx doc xlsx xls pptx ppt odt ods odp rtf epub zip 7z rar tar ' +
    'gz canvas'
  ).split(' '),
)

/** Does a wiki link name a file other than a note (`photo.png`, `Folder/doc.pdf`)? Only by a known ending. */
export function isFileTarget(target: string): boolean {
  const name = target.split('#')[0].split('|')[0].trim()
  const ending = /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]
  return !!ending && FILE_ENDINGS.has(ending.toLowerCase())
}

/**
 * The vault path a relative Markdown link in `notePath` points at (`Anh%C3%A4nge/Foto%201.png` from
 * `Home/Shopping.md` is `Home/Anhänge/Foto 1.png`); a leading `/` is the space's root. Null for web addresses and
 * for anything that would leave the space.
 */
export function relativeTarget(notePath: string, written: string): string | null {
  if (!written || /^[a-z][a-z0-9+.-]*:/i.test(written) || written.startsWith('#')) return null
  let target = written.split('#')[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    // Not escaped the way a browser writes it: taken as it stands.
  }
  const space = notePath.split('/')[0]
  const parts = target.startsWith('/') ? [space] : notePath.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length <= 1) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.length > 1 ? parts.join('/') : null
}

/** A picture pasted from the clipboard comes as `image.png` or without a name: it is named after the note. */
export function isPasted(file: { name?: string }): boolean {
  return !file.name || /^image(\.[a-z0-9]+)?$/i.test(file.name)
}

export function formatSize(bytes: number, locale?: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit && value < 10 ? 1 : 0 })} ${units[unit]}`
}
