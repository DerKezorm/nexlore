/**
 * The server's vault API. Every call names this browser tab in `X-Nexlore-Client`: an edit lock belongs to a tab,
 * so the same person in two tabs cannot type over themselves.
 *
 * Errors come back as `ApiError` with the server's code; the page builds its sentence from `errors.byCode`.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly values: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

const CLIENT_KEY = 'nexlore.client'

function randomId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return 'tab-' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

let clientId: string | null = null

/** One id per tab: sessionStorage survives a reload of the tab but is not shared with other tabs. */
export function tabId(): string {
  if (clientId) return clientId
  try {
    clientId = sessionStorage.getItem(CLIENT_KEY)
    if (!clientId) {
      clientId = randomId()
      sessionStorage.setItem(CLIENT_KEY, clientId)
    }
  } catch {
    clientId = randomId()
  }
  return clientId
}

type Options = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  query?: Record<string, string | number | string[] | undefined>
  body?: unknown
  form?: FormData
  keepalive?: boolean
}

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item)
    else if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Nexlore-Client': tabId() }
  let body: BodyInit | undefined
  if (options.form) body = options.form
  else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(url.pathname + url.search, {
    method: options.method ?? 'GET',
    headers,
    body,
    keepalive: options.keepalive,
  })
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = data?.detail
    if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
      const { code, message: _message, ...values } = detail
      throw new ApiError(response.status, code, values)
    }
    throw new ApiError(response.status, response.status === 401 ? 'sign_in_required' : 'internal_error')
  }
  return data as T
}

export type Space = { id: number; name: string; notes: number; files: number }
export type Lock = { holder: string; mine: boolean; expires_at: string }
export type NoteData = {
  id: number
  path: string
  title: string
  content: string
  hash: string
  bom: boolean
  readonly: boolean
  size: number
  modified: number
  front: Record<string, unknown> | null
  tags: string[]
  lock: Lock | null
}
export type NoteState = { hash: string; modified: number; lock: Lock | null }
export type Saved = { saved: boolean; hash: string; conflict: string | null }
export type Outgoing = { kind: string; target: string; subpath: string; line: number; path: string | null; title: string | null }
export type Backlink = { path: string; title: string; line: number; kind: string }
export type Links = { outgoing: Outgoing[]; backlinks: Backlink[] }
export type Hit = { path: string; title: string; snippet: string }
export type Graph = { nodes: [number, string, string][]; links: [number, number][] }
export type VersionInfo = { id: number; path: string; created_at: string; updated_at: string; source: string; author: string | null; size: number }
export type TrashEntry = { id: string; path: string; files: number; deleted_at: string; how: string; by: string | null }
export type Finding = { count: number; examples: string[] }
export type Report = {
  space: string
  notes: number
  other_files: number
  bytes: number
  links: number
  unresolved_links: Finding
  plugins: Record<string, Finding>
  obsidian: Record<string, number>
  front_matter_errors: Finding
  not_utf8: Finding
  too_large: Finding
  unportable_names: Finding
  case_collisions: Finding
  renamed_on_import: Finding
  hidden_skipped: number
  obsidian_config: boolean
  community_plugins: string[]
}
export type IndexState = {
  running: boolean
  phase: string
  done: number
  total: number
  last_at: string | null
  last: { files: number; added: number; changed: number; removed: number; moved: number; held_back: number; seconds: number } | null
  held_back: Record<string, number>
}

export type Uploaded = {
  /** What to link: for a HEIC photo its WebP, else the file itself. */
  path: string
  size: number
  kind: string | null
  /** The space held this content already; nothing new was stored. */
  duplicate: boolean
  /** What came out of it: `location`, `device`, `metadata`, or `unchecked`. */
  removed: string[]
  original: string | null
  /** The link text for the note it was uploaded for, relative and escaped. */
  link: string
}
export type Attachment = { id: number; path: string; size: number; modified: number; owner: string | null; uses: number }
export type Usage = { used: number; quota: number; per_file: number; folder: string; strip_location: boolean }

/** The address a file of the vault is shown or downloaded from. */
export function fileUrl(path: string, download = false): string {
  return `/api/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`
}

/**
 * A file sent as it is, streamed (no form, no copy in memory), with progress. `fetch` cannot report the progress of
 * what it sends, so this is one of the few places left for XMLHttpRequest.
 */
export function uploadFile(
  file: Blob & { name?: string },
  where: { note?: string; folder?: string; pasted?: boolean; name?: string },
  onProgress?: (share: number) => void,
): Promise<Uploaded> {
  const query = new URLSearchParams({ name: where.name ?? file.name ?? 'file', pasted: where.pasted ? 'true' : 'false' })
  if (where.note) query.set('note', where.note)
  if (where.folder) query.set('folder', where.folder)
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `/api/attachments?${query}`)
    request.setRequestHeader('X-Nexlore-Client', tabId())
    request.setRequestHeader('Accept', 'application/json')
    request.upload.onprogress = (event) => event.lengthComputable && onProgress?.(event.loaded / event.total)
    request.onerror = () => reject(new ApiError(0, 'network_error'))
    request.onload = () => {
      let data: { detail?: { code?: string; message?: string } & Record<string, unknown> } | Uploaded | null
      try {
        data = JSON.parse(request.responseText)
      } catch {
        data = null
      }
      if (request.status === 201) return resolve(data as Uploaded)
      const detail = (data as { detail?: Record<string, unknown> } | null)?.detail
      if (detail && typeof detail.code === 'string') {
        const { code, message: _message, ...values } = detail
        return reject(new ApiError(request.status, code as string, values))
      }
      reject(new ApiError(request.status, request.status === 413 ? 'too_large' : 'internal_error'))
    }
    request.send(file)
  })
}

export const vaultApi = {
  spaces: () => api<Space[]>('/api/spaces'),
  createSpace: (name: string) => api<Space>('/api/spaces', { method: 'POST', body: { name } }),
  graph: (space: string) => api<Graph>('/api/graph', { query: { space } }),
  note: (path: string) => api<NoteData>('/api/note', { query: { path } }),
  /** How the note stands on disk, without its text: for noticing changes made elsewhere. */
  noteState: (path: string) => api<NoteState>('/api/note/state', { query: { path } }),
  /** `keepalive`: the request outlives a closing tab. Browsers allow that only for small bodies (64 KB in all). */
  save: (path: string, content: string, baseHash: string, keepalive = false) =>
    api<Saved>('/api/note', { method: 'PUT', body: { path, content, base_hash: baseHash }, keepalive: keepalive && content.length < 60_000 }),
  create: (folder: string, title: string, content = '') =>
    api<NoteData>('/api/notes', { method: 'POST', body: { folder, title, content } }),
  /** `along`: files only this note uses that go into the trash with it (see `own`). */
  remove: (path: string, along: string[] = []) => api<{ files: number }>('/api/files', { method: 'DELETE', query: { path, along } }),
  /** The files only this note uses. */
  own: (path: string) => api<{ paths: string[] }>('/api/files/own', { query: { path } }),
  move: (source: string, destination: string) =>
    api<{ path: string; files: number; rewritten: number }>('/api/move', { method: 'POST', body: { source, destination } }),
  links: (path: string) => api<Links>('/api/links', { query: { path } }),
  search: (q: string, space?: string) => api<Hit[]>('/api/search', { query: { q, space, limit: 30 } }),
  lock: (path: string) => api<Lock>('/api/locks', { method: 'POST', body: { path } }),
  unlock: (path: string, keepalive = false) => api<void>('/api/locks', { method: 'DELETE', query: { path }, keepalive }),
  versions: (path: string) => api<VersionInfo[]>('/api/versions', { query: { path } }),
  version: (id: number) => api<{ id: number; path: string; content: string }>(`/api/versions/${id}`),
  restoreVersion: (id: number) => api<{ path: string }>(`/api/versions/${id}/restore`, { method: 'POST' }),
  trash: () => api<TrashEntry[]>('/api/trash'),
  restoreTrash: (id: string) => api<{ paths: string[] }>(`/api/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  purgeTrash: (id: string) => api<{ files: number }>(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  index: () => api<IndexState>('/api/index'),
  rescan: (confirmDeletions = false) =>
    api<unknown>('/api/index/scan', { method: 'POST', query: { confirm_deletions: confirmDeletions ? 'true' : undefined } }),
  report: (space: string) => api<Report>(`/api/spaces/${encodeURIComponent(space)}/report`),
  attachments: (space: string, unused = false, offset = 0) =>
    api<{ total: number; items: Attachment[] }>('/api/attachments', {
      query: { space, unused: unused ? 'true' : undefined, offset, limit: 200 },
    }),
  usage: () => api<Usage>('/api/attachments/usage'),
  /** Where a link written in `source` leads, before the note is saved: the server resolves it like a saved one. */
  resolve: (source: string, target: string, kind: 'wiki' | 'embed' | 'md' | 'md_embed') =>
    api<{ path: string | null; is_note: boolean }>('/api/resolve', { query: { source, target, kind } }),
  importVault: (file: File, name: string) => {
    const form = new FormData()
    form.set('file', file)
    form.set('name', name)
    return api<Report>('/api/import', { method: 'POST', form })
  },
}
