/** Public pages: their addresses, and where their links and pictures lead (only to what the share lets out). */
import { publicFileUrl, type PublicPage } from '../api/client'
import type { Targets } from './markdown'

/** The address of a note of the share. */
export function publicRoute(token: string, path: string): string {
  return `/s/${encodeURIComponent(token)}/` + path.split('/').map(encodeURIComponent).join('/')
}

const FILE = /^file:(\d+):/

function decoded(href: string): string {
  try {
    return decodeURIComponent(href.split('#')[0])
  } catch {
    return href.split('#')[0]
  }
}

/** Links of the page as the renderer needs them: a note of the share by its path, a file as `file:<id>:<name>`. */
export function publicTargets(token: string, page: PublicPage): { resolve: (target: string) => string | null; targets: Targets } {
  const wiki = new Map<string, string | null>()
  const markdown = new Map<string, string | null>()
  for (const link of page.links) {
    const value = link.note ?? (link.file !== null ? `file:${link.file}:${link.target.split('/').pop()}` : null)
    ;(link.kind.startsWith('md') ? markdown : wiki).set(link.target, value)
  }
  const id = (path: string) => Number(FILE.exec(path)?.[1] ?? -1)
  return {
    resolve: (target) => wiki.get(target) ?? null,
    targets: {
      fileUrl: (path) => publicFileUrl(token, id(path)),
      fileHref: (path) => publicFileUrl(token, id(path)),
      noteAttributes: (path) => `href="${publicRoute(token, path).replace(/"/g, '&quot;')}"`,
      noteHref: (path) => publicRoute(token, path),
      relative: (href) => markdown.get(decoded(href)) ?? null,
      closed: (href) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !markdown.get(decoded(href)),
      missing: (text) => text,
    },
  }
}
