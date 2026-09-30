/**
 * The pictures of a note as the page shows them, for the picture viewer (`components/ImageViewer.tsx`): where each
 * comes from, its name, and its path in the vault when it lies there (a picture from the web has none: it can be
 * looked at, not packed). Saving one picture is a plain download; several go as one ZIP from the server.
 */
import { api, fileUrl } from '../api/client'

export type Picture = { src: string; name: string; path: string | null }

/** The vault path in the address the server shows a file from (`/api/file?path=…`); null for any other address. */
export function pathOfSrc(src: string): string | null {
  try {
    const url = new URL(src, window.location.origin)
    if (url.origin !== window.location.origin || url.pathname !== '/api/file') return null
    return url.searchParams.get('path')
  } catch {
    return null
  }
}

/** Every picture in an element (the text being read, or the editor), in the order they stand. */
export function picturesIn(root: Element): { pictures: Picture[]; elements: HTMLImageElement[] } {
  const elements = [...root.querySelectorAll('img')].filter((image) => image.getAttribute('src'))
  const pictures = elements.map((image) => {
    const src = image.currentSrc || image.src
    const path = pathOfSrc(src)
    const name = path ? path.split('/').pop()! : decodeURIComponent(new URL(src, window.location.origin).pathname.split('/').pop() || '') || image.alt || src
    return { src, name, path }
  })
  return { pictures, elements }
}

/** Starts a download of what the address answers (the session goes along). */
function save(href: string, name: string) {
  const link = document.createElement('a')
  link.href = href
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** One picture straight, several as one ZIP named after the note; pictures from the web are left out. */
export async function downloadPictures(pictures: Picture[], archive: string): Promise<number> {
  const inVault = pictures.filter((picture): picture is Picture & { path: string } => !!picture.path)
  if (!inVault.length) return 0
  if (inVault.length === 1) {
    save(fileUrl(inVault[0].path, true), inVault[0].name)
    return 1
  }
  const blob = await api<Blob>('/api/files/zip', { method: 'POST', body: { paths: inVault.map((picture) => picture.path), name: archive }, blob: true })
  const url = URL.createObjectURL(blob)
  save(url, `${archive}.zip`)
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return inVault.length
}
