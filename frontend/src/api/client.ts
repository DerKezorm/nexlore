/**
 * The server's vault API. Every call names this browser tab in `X-Nexlore-Client`: an edit lock belongs to a tab,
 * so the same person in two tabs cannot type over themselves.
 *
 * Errors come back as `ApiError` with the server's code; the page builds its sentence from `errors.byCode`.
 */

import { nameRefused } from '../lib/errors'
import { readerNow } from '../lib/everyday'
import type { Appearance } from '../lib/appearance'
import type { Colours, Weak } from '../lib/themes'

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
/** Sent on `window` when a request finds that the session is gone: the page goes back to the sign-in. */
export const SIGNED_OUT_EVENT = 'nexlore:signed-out'
/** What a signed-out page still asks for. */
const OPEN_WHEN_SIGNED_OUT = /^\/api\/(auth|setup|locales|oidc|public|invite)(\/|$)/
let signedOut = false

/** Once signed out, nothing but signing in goes out: the goodbye of a closing note or a poll still running would
 * only meet 401 (P1.23). Such a call never settles; nobody is left to wait for it. */
export function setSignedOut(value: boolean): void {
  signedOut = value
}

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
  /** The answer is a file (a backup archive), not JSON. */
  blob?: boolean
}

/** How often a read or a save is tried again when the server says it is busy (503 `busy`), and how long apart. */
const BUSY_TRIES = 3
const BUSY_WAIT_MS = 1500

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  // Reading and saving are safe to send again (a save carries its base, a repeat changes nothing); making things is not.
  const repeatable = (options.method ?? 'GET') === 'GET' || options.method === 'PUT'
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(path, options)
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'busy' && repeatable && attempt < BUSY_TRIES)) throw error
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
    }
  }
}

async function once<T>(path: string, options: Options): Promise<T> {
  const url = new URL(path, window.location.origin)
  if (signedOut && !OPEN_WHEN_SIGNED_OUT.test(url.pathname)) return new Promise<T>(() => undefined)
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
  if (options.blob && response.ok) return (await response.blob()) as T
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = data?.detail
    if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
      const { code, message: _message, ...values } = detail
      if (code === 'name_invalid') nameRefused(values)
      if (code === 'sign_in_required') window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
      throw new ApiError(response.status, code, values)
    }
    throw new ApiError(response.status, response.status === 401 ? 'sign_in_required' : 'internal_error')
  }
  return data as T
}

export type Role = 'read' | 'write' | 'manage'
export type Space = {
  id: number
  name: string
  notes: number
  files: number
  role: Role
  /** Where the space keeps its templates and its daily notes. */
  template_folder?: string
  daily_folder?: string
  /** How its daily notes are named (`DD.MM.YYYY`, `lib/dayname`). */
  daily_format?: string
  /** The theme its managers set for the space's notes; empty for none. */
  theme?: string
}
export type Lock = { holder: string; mine: boolean; expires_at: string; own?: boolean }
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
export type NoteState = { hash: string; modified: number; lock: Lock | null; comments?: string }
export type Saved = { saved: boolean; hash: string; conflict: string | null }
export type Outgoing = { kind: string; target: string; subpath: string; line: number; path: string | null; title: string | null }
export type Backlink = { path: string; title: string; line: number; kind: string; context?: string | null; subpath?: string }
export type Links = { outgoing: Outgoing[]; backlinks: Backlink[] }
export type Hit = { path: string; title: string; snippet: string }
export type Found = { path: string; title: string; link?: string | null; alias?: string | null }
export type FolderEntry = { name: string; path: string; notes: number; files?: number }
export type FileEntry = { id: number; name: string; path: string; title: string; is_note: boolean; size: number; modified: number }
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
/** Whether the vault is being read right now; the counts only for the operator, a share for everybody. */
export type IndexProgress = {
  running: boolean
  phase?: string
  percent?: number | null
  done?: number
  total?: number
  /** Grows with every change the index takes in, from wherever it came: the tree loads again when it moved. */
  revision?: number
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
        if (code === 'name_invalid') nameRefused(values)
        return reject(new ApiError(request.status, code as string, values))
      }
      reject(new ApiError(request.status, request.status === 413 ? 'too_large' : 'internal_error'))
    }
    request.send(file)
  })
}

/** A space's or folder's symbol and colour chosen by hand; null: nexlore's own. */
export type Look = { icon: string | null; color: string | null }
/** Space name, then folder within it ("" is the space itself). */
export type Looks = Record<string, Record<string, Look>>

export const looksApi = {
  get: () => api<{ looks: Looks; icons: string[]; colors: string[] }>('/api/looks'),
  put: (path: string, icon: string | null, color: string | null) => api<void>('/api/looks', { method: 'PUT', body: { path, icon, color } }),
}

/** A place another note names this one without a link (`/api/mentions`). */
export type Mention = {
  path: string
  title: string
  line: number
  column: number
  words: string
  before: string
  after: string
  /** The wiki link that reaches the note from there. */
  link: string
  writable: boolean
}

export type Cleanup = {
  lonely: { path: string; title: string }[]
  lonely_total: number
  broken: { path: string; title: string; line: number; target: string; kind: string }[]
  broken_total: number
}

/** The calendar subscription of the own account; the address comes once, when it is made. */
export const feedApi = {
  state: () => api<{ allowed: boolean; active: boolean }>('/api/me/calendar-feed'),
  make: () => api<{ path: string }>('/api/me/calendar-feed', { method: 'POST' }),
  stop: () => api<void>('/api/me/calendar-feed', { method: 'DELETE' }),
}

export type LogLine = { time: string; level: string; logger: string; message: string; request_id: string | null; user: string | null }
export type LogMode = { mode: string; until: string | null; fixed_by_env: boolean; modes: string[]; durations: number[] }

/** The server's log, for the operator. */
export const logsApi = {
  read: (level?: string, search?: string) => api<LogLine[]>('/api/logs', { query: { level, search, limit: 300 } }),
  mode: () => api<LogMode>('/api/logs/level'),
  setMode: (mode: string, minutes: number) => api<LogMode>('/api/logs/level', { method: 'PUT', body: { mode, minutes } }),
  clear: () => api<void>('/api/logs', { method: 'DELETE' }),
}

/** A space as one ZIP file: the browser downloads it with the session it has. */
export function spaceZipUrl(space: string): string {
  return `/api/spaces/${encodeURIComponent(space)}/zip`
}

export type ThreadComment = { id: number; author: string; body: string; created_at: string; edited_at: string | null; mine: boolean }
export type Thread = {
  id: number
  quote: string
  before: string
  after: string
  resolved: boolean
  resolved_by: string
  may_resolve: boolean
  comments: ThreadComment[]
}

/** Comments in the margin of a note: in the database, never in the file. */
export const commentsApi = {
  list: (path: string) => api<{ threads: Thread[] }>('/api/comments', { query: { path } }),
  start: (path: string, anchor: { quote: string; before: string; after: string }, body: string) =>
    api<{ id: number }>('/api/comments', { method: 'POST', body: { path, ...anchor, body } }),
  reply: (path: string, thread: number, body: string) => api<{ id: number }>(`/api/comments/${thread}/replies`, { method: 'POST', body: { path, body } }),
  edit: (path: string, id: number, body: string) => api<{ id: number }>(`/api/comments/${id}`, { method: 'PUT', body: { path, body } }),
  remove: (path: string, id: number) => api<void>(`/api/comments/${id}`, { method: 'DELETE', query: { path } }),
  resolve: (path: string, thread: number, done: boolean) => api<void>(`/api/comments/${thread}/resolve`, { method: 'POST', body: { path, done } }),
  people: (path: string, q: string) => api<string[]>('/api/comments/people', { query: { path, q } }),
}

/** Somebody else with the note open: whose picture, and whether it is the one writing. */
export type Present = { id: number; name: string; avatar: string | null; writing: boolean }

export const presenceApi = {
  here: (path: string) => api<{ people: Present[] }>('/api/presence', { method: 'POST', body: { path } }),
  gone: (path: string) => api<void>('/api/presence', { method: 'DELETE', query: { path }, keepalive: true }),
}

export const captureApi = {
  /** Words on top of the space's inbox note; `stamp` is this browser's clock, `language` names a new inbox. */
  put: (space: string, text: string, stamp: string, language: string) =>
    api<{ path: string }>('/api/inbox', { method: 'POST', body: { space, text, stamp, language } }),
}

export const mentionsApi = {
  of: (path: string) => api<{ places: Mention[]; more: boolean }>('/api/mentions', { query: { path } }),
  link: (target: string, place: Mention) =>
    api<{ link: string }>('/api/mentions/link', {
      method: 'POST',
      body: { source: place.path, target, line: place.line, column: place.column, words: place.words },
    }),
  cleanup: (space: string) => api<Cleanup>('/api/cleanup', { query: { space } }),
}

export const vaultApi = {
  spaces: () => api<Space[]>('/api/spaces'),
  /** What lies directly in a space or folder. */
  folder: (path: string, offset?: number, limit?: number) =>
    api<{ path: string; folders: FolderEntry[]; files: FileEntry[]; total_files: number }>('/api/folder', { query: { path, offset, limit } }),
  /** The conflict copies of a note, or for a copy its note. */
  copies: (path: string) => api<{ paths: string[] }>('/api/note/copies', { query: { path } }),
  createSpace: (name: string) => api<Space>('/api/spaces', { method: 'POST', body: { name } }),
  /** Notes by title or name, the best first; nothing typed: the ones changed last. */
  find: (q: string, space?: string, limit = 20) => api<Found[]>('/api/notes/find', { query: { q, space, limit } }),
  /** `source` into `target`: its text to the end, links along, `source` to the trash. */
  merge: (source: string, target: string) => api<{ path: string; rewritten: number }>('/api/notes/merge', { method: 'POST', body: { source, target } }),
  findFolders: (q: string, limit = 20) => api<{ path: string; name: string }[]>('/api/folders/find', { query: { q, limit } }),
  /** The same from a note being edited: its space only, and the link text that reaches each hit from there. */
  findFrom: (q: string, source: string, limit = 8) => api<Found[]>('/api/notes/find', { query: { q, source, limit } }),
  note: (path: string) => api<NoteData>('/api/note', { query: { path } }),
  /** How the note stands on disk, without its text: for noticing changes made elsewhere. */
  noteState: (path: string) => api<NoteState>('/api/note/state', { query: { path } }),
  /** `keepalive`: the request outlives a closing tab. Browsers allow that only for small bodies (64 KB in all). */
  save: (path: string, content: string, baseHash: string, keepalive = false) =>
    api<Saved>('/api/note', { method: 'PUT', body: { path, content, base_hash: baseHash }, keepalive: keepalive && content.length < 60_000 }),
  /** `template`: a template of the same space to start from; its placeholders are filled by the server. */
  create: (folder: string, title: string, content = '', template?: string) =>
    api<NoteData>('/api/notes', { method: 'POST', body: { folder, title, content, template, now: readerNow() } }),
  /** `along`: files only this note uses that go into the trash with it (see `own`). */
  createFolder: (parent: string, name: string, existingOk = false) =>
    api<{ path: string }>('/api/folders', { method: 'POST', body: { parent, name, existing_ok: existingOk } }),
  remove: (path: string, along: string[] = []) => api<{ files: number }>('/api/files', { method: 'DELETE', query: { path, along } }),
  /** The files only this note uses. */
  own: (path: string) => api<{ paths: string[] }>('/api/files/own', { query: { path } }),
  move: (source: string, destination: string) =>
    api<{ path: string; files: number; rewritten: number }>('/api/move', { method: 'POST', body: { source, destination } }),
  /** A space gets another name; links naming it in front follow (block Y2). */
  renameSpace: (space: string, name: string) =>
    api<{ path: string; files: number; rewritten: number }>(`/api/spaces/${encodeURIComponent(space)}/rename`, { method: 'POST', body: { name } }),
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
  progress: () => api<IndexProgress>('/api/index/progress'),
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
  /** The same for many wiki links at once (at most 200): each target as written, to a path or null. */
  resolveMany: (source: string, targets: string[]) =>
    api<{ found: Record<string, string | null> }>('/api/resolve/many', { query: { source, target: targets, kind: 'wiki' } }),
  importVault: (file: File, name: string) => {
    const form = new FormData()
    form.set('file', file)
    form.set('name', name)
    return api<Report>('/api/import', { method: 'POST', form })
  },
}

/** A canvas (`.canvas`, JSON Canvas) with its state. `readonly`: shown, never saved (`problem` says why). */
export type CanvasData = {
  path: string
  content: string
  hash: string
  size: number
  modified: number
  readonly: boolean
  problem: string | null
  lock: Lock | null
  /** Where each card's path leads for whoever asks, from the vault's top; null: nowhere, or not for them. */
  cards: Record<string, string | null>
  /** Cards in a space whoever asks may not read: shown locked. */
  locked: string[]
}

export const canvasApi = {
  read: (path: string) => api<CanvasData>('/api/canvas', { query: { path } }),
  state: (path: string) => api<{ hash: string; modified: number; lock: Lock | null }>('/api/canvas/state', { query: { path } }),
  save: (path: string, content: string, baseHash: string, keepalive = false) =>
    api<Saved>('/api/canvas', { method: 'PUT', body: { path, content, base_hash: baseHash }, keepalive: keepalive && content.length < 60_000 }),
  /** The canvases a note, file or folder lies on (those the asker may read), for the warning before the trash. */
  lyingOn: (path: string) => api<{ count: number; paths: string[] }>('/api/canvases/on', { query: { path } }),
  /** `name` without `.canvas`; a name taken already gets a number. */
  create: (folder: string, name: string) => api<CanvasData>('/api/canvases', { method: 'POST', body: { folder, name } }),
}

// --- Accounts, rights, invitations -----------------------------------------------------------------------------------

export type Account = {
  id: number
  name: string
  /** How others see the account; empty shows the name. */
  display_name: string
  /** The running version, and the one whose "What's new" the account has read (block X3). */
  version: string
  whats_new_seen: string
  role: 'operator' | 'member'
  sign_in: 'password' | 'oidc'
  /** The address that counts (it is mailed; it never finds an account at a sign-in through a provider). */
  email: string
  /** Where it came from; empty without one. */
  email_source: '' | 'own' | 'operator' | 'invite' | 'provider'
  /** An address entered in the profile that waits for its link to be opened; empty when none waits. */
  email_pending: string
  /** The provider's address, offered when it differs from the own one (linked accounts with a password). */
  provider_email: string
  language: string
  two_factor: boolean
  two_factor_recovery_left: number
  created_at: string
  last_seen_at: string | null
  /** When the profile picture was set (it makes its address new), or null without one. */
  avatar: string | null
}
/** `second_factor_setup_required`: the operator requires a second factor this account has not set up yet. */
export type Me = Account & {
  shares_allowed: boolean
  mail: boolean
  /** Why the profile cannot send a confirmation now (`mail_off`, `public_url_missing`), empty when it can. */
  email_confirm?: string
  second_factor_setup_required: boolean
  /** The editor offers AI: the operator allows it and the account switched its own service on. */
  ai_ready?: boolean
  /** The operator allows AI at all: Frag Lore stands in the header, and says what is missing when not ready. */
  ai_allowed?: boolean
  /** The operator switched Frag Lore on (above AI in notes). */
  lore_allowed?: boolean
  /** Frag Lore shows: switched on, and an AI service ready for this account. */
  lore?: boolean
  /** Pasted links get the page's title (the operator allows asking the pages). */
  link_titles?: boolean
  appearance?: Appearance
  /** The colours of the chosen theme; null: nexlore's own. */
  theme_colours?: Colours | null
  /** The own CSS snippets in force (empty unless the operator allows own CSS). */
  own_css?: string[]
}
/** A provider an account is linked to, as a mark in the operator's account list. */
export type LinkedProvider = { id: number; slug: string; label: string }
export type AdminAccount = Account & { spaces: number; locked: boolean; providers: LinkedProvider[] }
export type SetupState = { needs_setup: boolean; signed_in: boolean; version: string; min_password: number }
/** A button of the sign-in page: an active provider (the shared sign-in module, vendor/nexoidc). */
export type ProviderButton = { slug: string; label: string }
export type Methods = { password: boolean; providers: ProviderButton[] }
/** An active provider and whether the own account is linked to it. */
export type MyProvider = ProviderButton & { linked: boolean }
export type Member = { name: string; role: Role; you: boolean }
export type Invite = { id: number; role: string; email: string; by: string | null; created_at: string; expires_at: string }
export type NewInvite = Invite & { link: string; sent: boolean }
export type Members = { space: string; members: Member[]; invites: Invite[]; role: Role | null }
export type InviteOffer = { space: string | null; role: Role | null; min_password: number; signed_in_as: string | null }
export type AdminSpace = { name: string; members: number; managers: string[]; role: Role | null }

export type About = { version: string; license: string; repo_url: string; releases_url: string; project_url: string }
export type Updates = {
  update_check: boolean
  checked: boolean
  latest: string | null
  newer: boolean
  checked_at: string | null
  release_url: string | null
}

/** About nexlore and whether a newer one is out (block X2); switching and asking now are the operator's. */
export const aboutApi = {
  about: () => api<About>('/api/about'),
  updates: () => api<Updates>('/api/about/updates'),
  check: () => api<Updates>('/api/about/updates/check', { method: 'POST' }),
  setCheck: (on: boolean) => api<Updates>('/api/about/updates', { method: 'PUT', body: { update_check: on } }),
}

export const authApi = {
  setupState: () => api<SetupState>('/api/setup'),
  setup: (name: string, password: string, language: string, code: string) =>
    api<Account>('/api/setup', { method: 'POST', body: { name, password, language, code } }),
  methods: () => api<Methods>('/api/auth/methods'),
  /** Signed in, or `second_factor`: the password was right, the code from the app comes next. */
  login: (name: string, password: string) =>
    api<Account | { second_factor: true }>('/api/auth/login', { method: 'POST', body: { name, password } }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  logoutEverywhere: () => api<void>('/api/auth/logout-all', { method: 'POST' }),
  me: () => api<Me>('/api/auth/me'),
  changePassword: (current: string, next: string) => api<void>('/api/auth/password', { method: 'PUT', body: { current, new: next } }),
  setLanguage: (language: string) => api<Account>('/api/me/language', { method: 'PUT', body: { language } }),
  whatsNewSeen: () => api<Account>('/api/me/whats-new/seen', { method: 'POST' }),
  setProfile: (displayName: string) => api<Account>('/api/me/profile', { method: 'PUT', body: { display_name: displayName } }),
  /** The own address: a link goes to it, and it counts once that is opened (`sent` false: it was the address already). */
  setEmail: (address: string) => api<Account & { sent: boolean }>('/api/me/email', { method: 'PUT', body: { address } }),
  resendEmail: () => api<Account>('/api/me/email/resend', { method: 'POST' }),
  cancelEmail: () => api<Account>('/api/me/email/pending', { method: 'DELETE' }),
  removeEmail: () => api<Account>('/api/me/email', { method: 'DELETE' }),
  takeProviderEmail: () => api<Account>('/api/me/email/provider', { method: 'POST' }),
  declineProviderEmail: () => api<Account>('/api/me/email/provider', { method: 'DELETE' }),
  /** The link from the mail; works without being signed in. */
  confirmEmail: (token: string) => api<{ email: string; name: string }>('/api/email/confirm', { method: 'POST', body: { token } }),
  setAppearance: (changes: Partial<Appearance>) => api<Appearance>('/api/me/appearance', { method: 'PUT', body: changes }),
  myProviders: () => api<MyProvider[]>('/api/oidc/me'),
  linkStart: (slug: string, password: string) =>
    api<{ url: string }>(`/api/oidc/${encodeURIComponent(slug)}/link`, { method: 'POST', body: { password } }),
  unlink: (slug: string) => api<void>(`/api/oidc/${encodeURIComponent(slug)}/link`, { method: 'DELETE' }),
  /** The picture itself as the body; the server draws a small square of it anew. */
  setAvatar: async (file: Blob): Promise<Account> => {
    const response = await fetch('/api/auth/avatar', {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream', 'X-Nexlore-Client': tabId() },
      body: file,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const found = data?.detail
      throw new ApiError(response.status, typeof found?.code === 'string' ? found.code : response.status === 413 ? 'too_large' : 'internal_error', found ?? {})
    }
    return data as Account
  },
  removeAvatar: () => api<Account>('/api/auth/avatar', { method: 'DELETE' }),

  members: (space: string) => api<Members>(`/api/spaces/${encodeURIComponent(space)}/members`),
  /** A member's right changes; any other name gets an invitation (``invited``), known or not. */
  setMember: (space: string, name: string, role: Role) =>
    api<Member & { invited?: boolean }>(`/api/spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(name)}`, { method: 'PUT', body: { role } }),
  removeMember: (space: string, name: string) =>
    api<void>(`/api/spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  inviteToSpace: (space: string, role: Role, days: number, email = '', send = false) =>
    api<NewInvite>(`/api/spaces/${encodeURIComponent(space)}/invites`, { method: 'POST', body: { role, days, email, send } }),
  invite: (days: number, email = '', send = false) => api<NewInvite>('/api/invites', { method: 'POST', body: { days, email, send } }),
  invites: () => api<Invite[]>('/api/invites'),
  withdrawInvite: (id: number) => api<void>(`/api/invites/${id}`, { method: 'DELETE' }),
  offer: (token: string) => api<InviteOffer>(`/api/invite/${encodeURIComponent(token)}`),
  accept: (token: string, name: string, password: string) =>
    api<Account>(`/api/invite/${encodeURIComponent(token)}`, { method: 'POST', body: { name, password } }),
  join: (token: string) => api<{ space: string | null }>(`/api/invite/${encodeURIComponent(token)}/join`, { method: 'POST' }),
  deleteSpace: (space: string) => api<{ files: number }>('/api/files', { method: 'DELETE', query: { path: space } }),
}

export type TotpEnrolment = { secret: string; uri: string; qr_svg: string }

export const totpApi = {
  begin: () => api<TotpEnrolment>('/api/auth/totp/begin', { method: 'POST' }),
  confirm: (code: string, password: string) =>
    api<{ recovery_codes: string[]; account: Account }>('/api/auth/totp/confirm', { method: 'POST', body: { code, password } }),
  disable: (password: string) => api<Account>('/api/auth/totp/disable', { method: 'POST', body: { password } }),
  recovery: (password: string) =>
    api<{ recovery_codes: string[]; account: Account }>('/api/auth/totp/recovery', { method: 'POST', body: { password } }),
  /** The second step of a sign-in: a code from the app or a recovery code. */
  code: (code: string) => api<Account>('/api/auth/login/totp', { method: 'POST', body: { code } }),
  cancel: () => api<void>('/api/auth/login/totp/cancel', { method: 'POST' }),
}

// --- The operator ---------------------------------------------------------------------------------------------------

export type ServerSettings = {
  public_url: string
  password_login: boolean
  two_factor_required: boolean
  shares_allowed: boolean
  backup_schedule: 'off' | 'daily' | 'weekly'
  backup_keep: number
  smtp_host: string
  smtp_port: number
  smtp_security: 'starttls' | 'tls' | 'none'
  smtp_user: string
  smtp_password_set: boolean
  smtp_from: string
  mcp_allowed: boolean
  mcp_max_level: McpLevel
  mcp_oauth_allowed: boolean
  api_tokens_allowed: boolean
  plugin_upload_allowed: boolean
  ai_allowed: boolean
  ai_private_hosts: string
  ai_mode: AiMode
  ai_per_minute: number
  lore_allowed: boolean
  custom_css_allowed: boolean
  calendar_feed_allowed: boolean
  link_titles_allowed: boolean
}
export type ServerSettingsChange = Partial<Omit<ServerSettings, 'smtp_password_set'>> & { smtp_password?: string }
export type FileSettings = { attachment_folder: string; upload_max_mb: number; quota_mb: number; strip_location: boolean }
/** An entry of the provider list as the operator sees it: never the secret, only whether one is stored. */
export type OidcProvider = {
  id: number
  slug: string
  label: string
  issuer: string
  client_id: string
  has_secret: boolean
  scopes: string
  enabled: boolean
  auto_create: boolean
  trusts_second_factor: boolean
  /** "" by hand, "authentik" through the button, "nexsuite" from a coupling. */
  managed: string
  position: number
  redirect_uri: string
  links: number
  editable: boolean
}
/** The provider form. `slug` counts only when adding; an empty `client_secret` keeps the stored one. */
export type OidcProviderForm = {
  label: string
  slug?: string
  issuer: string
  client_id: string
  client_secret: string
  scopes: string
  enabled: boolean
  auto_create: boolean
  trusts_second_factor: boolean
}
export type OidcImpact = { issuer_change: number; count: number; only: number; only_names: string[] }
export type AuthentikStep = { key: string; ok: boolean; detail: string; reason?: string; status?: number }
export type AuthentikResult = {
  ok: boolean
  steps: AuthentikStep[]
  client_id: string
  issuer: string
  provider_id: number | null
  links_dropped: number
}
export type Backup = { name: string; size: number; created: string; kind: string; note: string; notes: number; files: number; version: string; uploaded?: boolean }

/** The password for an upload rides in a header, as base64 of its UTF-8: a header carries no umlauts. */
export function passwordHeader(password: string): string {
  let bytes = ''
  for (const byte of new TextEncoder().encode(password)) bytes += String.fromCharCode(byte)
  return btoa(bytes)
}
export type BackupCheck = {
  name: string
  usable: boolean
  database_ok: boolean
  files_ok: boolean
  damaged: string[]
  version: string
  created: string
  kind: string
  notes: number
  files: number
  would_add: number
  would_change: number
  would_remove: number
  examples: { add: string[]; change: string[]; remove: string[] }
}
export type AddedLanguage = { code: string; name: string; keys: number }

// --- Favorites (services/favorites.py) -------------------------------------------------------------------------------

/** A note, folder or file by its path; a heading (`Note.md#Heading`, `note` is the note); a search (`?words`). */
export type Favorite = { path: string; kind: 'note' | 'folder' | 'file' | 'heading' | 'search'; title: string; note?: string; section: string }

export const linkTitleApi = {
  title: (url: string) => api<{ title: string | null }>('/api/link-title', { query: { url } }),
}

export const favoritesApi = {
  list: () => api<Favorite[]>('/api/favorites'),
  set: (path: string, on: boolean, section?: string) => api<void>('/api/favorites', { method: 'PUT', body: { path, on, section } }),
}

// --- New since the last visit and proposals (routers/news.py, routers/proposals.py) --------------------------------

export type NewNote = { path: string; title: string; changed_at: string; author: string }
/** An open thread where somebody named the account with `@name` since it last opened the note. */
export type NewsMention = { thread: number; path: string; title: string; author: string; at: string; excerpt: string }
export type Proposal = {
  id: number; path: string; title: string; by: string; message: string; status: 'open' | 'taken' | 'declined' | 'copied'
  created_at: string; decided_at: string | null; decided_by: string | null; content: string | null
  /** Written by Lore for the person who asked (`routers/lore.py`). */
  lore?: boolean
}

/** An invitation into a space by name, or a change the operator made in a space (routers/members.py). */
export type SpaceNotice = {
  id: number
  kind:
    | 'invite'
    | 'operator_added'
    | 'operator_role'
    | 'operator_removed'
    | 'operator_email'
    | 'operator_email_removed'
    | 'operator_unlinked'
  space: string
  role: string
  actor: string
  subject: string
  created_at: string
}

export const noticesApi = {
  list: () => api<SpaceNotice[]>('/api/notices'),
  accept: (id: number) => api<{ space: string }>(`/api/notices/${id}/accept`, { method: 'POST' }),
  /** Declines an invitation, or marks a notice seen. */
  decline: (id: number) => api<void>(`/api/notices/${id}/decline`, { method: 'POST' }),
}

export const newsApi = {
  list: () => api<{ count: number; notes: NewNote[]; mentions: NewsMention[] }>('/api/news'),
  seenAll: () => api<void>('/api/news/seen', { method: 'POST' }),
}

export const proposalsApi = {
  propose: (path: string, content: string, baseHash: string, message: string) =>
    api<Proposal>('/api/proposals', { method: 'POST', body: { path, content, base_hash: baseHash, message } }),
  forNote: (path: string) => api<Proposal[]>('/api/proposals/note', { query: { path } }),
  overview: () => api<{ waiting: Proposal[]; mine: Proposal[] }>('/api/proposals'),
  take: (id: number) => api<{ path: string; conflict: string | null; reason?: 'changed' | 'locked' | 'not_utf8' | null }>(`/api/proposals/${id}/take`, { method: 'POST' }),
  decline: (id: number) => api<void>(`/api/proposals/${id}/decline`, { method: 'POST' }),
  withdraw: (id: number) => api<void>(`/api/proposals/${id}`, { method: 'DELETE' }),
}

// --- Views over notes, as Obsidian's Bases (routers/bases.py) -----------------------------------------------------

export type BaseRow = { path: string; title: string; cells: Record<string, unknown> }
export type BaseAnswer = {
  views: { name: string; type: string }[]
  view: number
  kind: 'table' | 'cards' | 'list' | 'board'
  name: string
  columns: { key: string; label: string }[]
  group: string | null
  image: string | null
  groups: { value: string | null; rows: BaseRow[] }[]
  total: number
  problems: { code: string; values: Record<string, string | number>; text: string }[]
  /** For a .base file: its text and state, to edit it. */
  text?: string
  hash?: string
}

export const basesApi = {
  view: (path: string, view = 0) => api<BaseAnswer>('/api/bases/view', { query: { path, view } }),
  block: (source: string, text: string, view = 0) => api<BaseAnswer>('/api/bases/block', { method: 'POST', body: { source, text, view } }),
  cell: (path: string, key: string, value: unknown) => api<{ path: string; conflict: string | null }>('/api/bases/cell', { method: 'PUT', body: { path, key, value } }),
  create: (folder: string, name: string) => api<{ path: string }>('/api/bases', { method: 'POST', body: { folder, name } }),
  save: (path: string, text: string, baseHash: string) => api<{ path: string; hash: string }>('/api/bases/file', { method: 'PUT', body: { path, text, base_hash: baseHash } }),
}

// --- The search page (routers/search.py) -------------------------------------------------------------------------

export type SearchPage = { notes: { path: string; title: string; lines: { line: number; text: string }[] }[]; more: boolean; ms: number }

export const searchApi = {
  notes: (q: string, offset = 0) => api<SearchPage>('/api/search/notes', { query: { q, offset, limit: 30 } }),
}

// --- Colour themes and own CSS (routers/themes.py) -----------------------------------------------------------------

export type ThemeRow = { ref: string; id: number; name: string; colours: Colours; shared: boolean; weak: Weak[]; owner?: string }
export type ThemeList = { built_in: { ref: string; colours: Colours }[]; mine: ThemeRow[]; shared: ThemeRow[] }
export type Snippet = { id: number; name: string; css: string; enabled: boolean }

export const themesApi = {
  list: () => api<ThemeList>('/api/themes'),
  one: (ref: string) => api<{ ref: string; colours: Colours }>(`/api/themes/${encodeURIComponent(ref)}`),
  create: (name: string, colours: Colours, shared = false) => api<ThemeRow>('/api/themes', { method: 'POST', body: { name, colours, shared } }),
  change: (id: number, changes: { name?: string; colours?: Colours; shared?: boolean }) => api<ThemeRow>(`/api/themes/${id}`, { method: 'PUT', body: changes }),
  remove: (id: number) => api<void>(`/api/themes/${id}`, { method: 'DELETE' }),
}

export const cssApi = {
  list: () => api<{ allowed: boolean; snippets: Snippet[] }>('/api/css-snippets'),
  create: (name: string, css: string, enabled = true) => api<Snippet>('/api/css-snippets', { method: 'POST', body: { name, css, enabled } }),
  change: (id: number, changes: Partial<Omit<Snippet, 'id'>>) => api<Snippet>(`/api/css-snippets/${id}`, { method: 'PUT', body: changes }),
  remove: (id: number) => api<void>(`/api/css-snippets/${id}`, { method: 'DELETE' }),
}

// --- Tags and the notes opened last (routers/vault.py, routers/recent.py) --------------------------------------------

export type TagCount = { tag: string; count: number }
export type NoteRef = { path: string; title: string }
export type TagRenamed = { changed: number; locked: number; read_only: number }

export const tagsApi = {
  list: () => api<TagCount[]>('/api/tags'),
  /** The notes with the tag or one below it; `exact`: with this tag itself only. */
  notes: (tag: string, exact = false) => api<NoteRef[]>('/api/tags/notes', { query: exact ? { tag, exact: 'true' } : { tag } }),
  rename: (old: string, name: string) => api<TagRenamed>('/api/tags/rename', { method: 'POST', body: { old, new: name } }),
}

export type NoteNews = { author: string; changed_at: string; since_version: number | null }

export const recentApi = {
  /** The note was opened: what others changed since the last time (null: nothing), and it counts as seen now. */
  opened: (path: string) => api<{ news: NoteNews | null }>('/api/recent', { method: 'POST', body: { path } }),
  list: (limit = 10) => api<NoteRef[]>('/api/recent', { query: { limit } }),
}

// --- AI in notes, with the account's own service (services/ai.py) ----------------------------------------------------

export type AiTask = 'spelling' | 'rewrite' | 'translate' | 'summarize' | 'write'
export type AiAccess = { active: boolean; url: string; model: string; key_set: boolean }
/** Who brings the service: each account its own, or the operator one for all (Frag Lore, 05.10.2026). */
export type AiMode = 'own' | 'shared'
export type AiState = {
  allowed: boolean
  ready: boolean
  mode: AiMode
  access: AiAccess
  /** The operator's service as a member sees it: its model, never its address or key. */
  shared: { model: string; complete: boolean }
  tones: string[]
  /** How long conversations with Lore stay after their last question; 0: until removed. */
  keep_days: number
}
export type AiShared = {
  url: string
  model: string
  key_set: boolean
  complete: boolean
  /** The model that turns notes into vectors (finding them by meaning); empty: by their words only. */
  embed_model: string
  meaning: { done: number; total: number }
  meaning_on: boolean
}
export type AiModel = { id: string; name: string }
export type AiEvent = {
  id: number
  at: string
  model: string
  task: AiTask
  target: string
  tokens_in: number
  tokens_out: number
  error: string
  /** The request as it went out; shown as text, never rendered. */
  body: unknown
}

export const aiApi = {
  state: () => api<AiState>('/api/ai'),
  save: (change: Partial<{ active: boolean; url: string; model: string; key: string }>) => api<AiState>('/api/ai', { method: 'PUT', body: change }),
  models: (url?: string, key?: string) => api<AiModel[]>('/api/ai/models', { method: 'POST', body: { url, key } }),
  run: (task: AiTask, text: string, target = '', instruction = '') =>
    api<{ text: string }>('/api/ai/run', { method: 'POST', body: { task, text, target, instruction } }),
  events: () => api<AiEvent[]>('/api/ai/events'),
  /** The operator's service for all (operator only). */
  shared: () => api<AiShared>('/api/ai/shared'),
  saveShared: (change: Partial<{ url: string; model: string; key: string; embed_model: string }>) => api<AiShared>('/api/ai/shared', { method: 'PUT', body: change }),
  sharedModels: (url?: string, key?: string) => api<AiModel[]>('/api/ai/shared/models', { method: 'POST', body: { url, key } }),
  clear: () => api<{ removed: number }>('/api/ai/events', { method: 'DELETE' }),
}

// --- Frag Lore (services/lore.py): questions about the own notes, answered from them --------------------------------

export type LoreSource = { n: number; path: string; title: string; heading: string; excerpt: string }
/** How Lore searched: in how many spaces (and which), for which words, which notes it read. */
export type LoreStep = { tool: 'search'; words: string; found: number } | { tool: 'read'; n: number }
export type LoreTrace = {
  spaces: number
  space_names: string[]
  words: string[]
  read: string[]
  steps?: LoreStep[]
  /** Found by their meaning, not their words (one service for all with a model for it). */
  meant?: string[]
}
export type SimilarNote = { path: string; title: string; score: number }
export type LoreMessage = {
  id: number
  role: 'user' | 'assistant'
  at: string
  text: string
  sources: LoreSource[]
  trace: LoreTrace | null
  error: string
}
export type LoreConversation = { id: number; title: string; note: string | null; messages: LoreMessage[] }
export type LoreListed = { id: number; title: string; updated_at: string; note: boolean }
export type LoreAsk = { question: string; conversation?: number; spaces?: number[]; note?: string }
export type LoreEvent =
  | { name: 'start'; data: { conversation: number; sources: LoreSource[]; trace: LoreTrace } }
  | { name: 'delta'; data: { t: string } }
  /** Lore looked further (a model with tools): the sources as they are now, and the way it went. */
  | { name: 'sources'; data: { sources: LoreSource[]; trace: LoreTrace } }
  | { name: 'done'; data: { conversation: number; message: number } }
  | { name: 'error'; data: { code: string; values: Record<string, unknown> } }

export const loreApi = {
  /** The own conversations, newest first; with a note: those about it. */
  list: (note?: string) => api<LoreListed[]>('/api/lore/conversations', { query: { note } }),
  get: (id: number) => api<LoreConversation>(`/api/lore/conversations/${id}`),
  remove: (id: number) => api<{ removed: number }>(`/api/lore/conversations/${id}`, { method: 'DELETE' }),
  removeAll: () => api<{ removed: number }>('/api/lore/conversations', { method: 'DELETE' }),
  /** The notes nearest in meaning to a note; `on` false while finding by meaning is off. */
  similar: (path: string) => api<{ on: boolean; notes: SimilarNote[] }>('/api/lore/similar', { query: { path } }),
  /** An answer as a note of its own, with its sources as links; where the first source lies, if one may write there. */
  saveNote: (id: number, message: number) => api<{ path: string }>(`/api/lore/conversations/${id}/note`, { method: 'POST', body: { message } }),
  /** What an answer about a note says, as a proposal for that note: it waits there to be compared and taken over. */
  propose: (id: number, message: number, note?: string) => api<{ proposal: number; path: string }>(`/api/lore/conversations/${id}/propose`, { method: 'POST', body: { message, note } }),
}

export const adminApi = {
  settings: () => api<ServerSettings>('/api/settings'),
  saveSettings: (change: ServerSettingsChange) => api<ServerSettings>('/api/settings', { method: 'PUT', body: change }),
  /** The space with the guide, again, next to what is there ("nexlore 2" when "nexlore" is taken). */
  makeGuide: (language: string) => api<{ space: string }>('/api/settings/guide', { method: 'POST', body: { language } }),
  mailTest: (to: string) => api<void>('/api/settings/mail-test', { method: 'POST', body: { to } }),
  fileSettings: () => api<FileSettings>('/api/settings/files'),
  saveFileSettings: (values: FileSettings) => api<FileSettings>('/api/settings/files', { method: 'PUT', body: values }),
  accounts: () => api<AdminAccount[]>('/api/accounts'),
  // The four acts on another account carry the operator's own password once more (empty for a provider account).
  deleteAccount: (id: number, current_password: string) =>
    api<void>(`/api/accounts/${id}`, { method: 'DELETE', body: { current_password } }),
  signOutAccount: (id: number) => api<void>(`/api/accounts/${id}/sign-out`, { method: 'POST' }),
  resetSecondFactor: (id: number, current_password: string) =>
    api<Account>(`/api/accounts/${id}/totp/reset`, { method: 'POST', body: { current_password } }),
  setRole: (id: number, role: 'operator' | 'member', current_password: string) =>
    api<Account>(`/api/accounts/${id}/role`, { method: 'PUT', body: { role, current_password } }),
  setPassword: (id: number, password: string, current_password: string) =>
    api<void>(`/api/accounts/${id}/password`, { method: 'PUT', body: { password, current_password } }),
  /** Counts at once; empty removes it. The account is told under "New". */
  setEmail: (id: number, address: string, current_password: string) =>
    api<Account>(`/api/accounts/${id}/email`, { method: 'PUT', body: { address, current_password } }),
  spaces: () => api<AdminSpace[]>('/api/admin/spaces'),
  shares: () => api<ShareInfo[]>('/api/admin/shares'),
  providers: () => api<OidcProvider[]>('/api/oidc/admin/providers'),
  addProvider: (form: OidcProviderForm) => api<OidcProvider>('/api/oidc/admin/providers', { method: 'POST', body: form }),
  saveProvider: (id: number, form: OidcProviderForm) =>
    api<OidcProvider & { dropped: number }>(`/api/oidc/admin/providers/${id}`, { method: 'PUT', body: form }),
  removeProvider: (id: number) => api<OidcImpact>(`/api/oidc/admin/providers/${id}`, { method: 'DELETE' }),
  providerImpact: (id: number, issuer = '') =>
    api<OidcImpact>(`/api/oidc/admin/providers/${id}/impact${issuer ? `?issuer=${encodeURIComponent(issuer)}` : ''}`),
  orderProviders: (ids: number[]) => api<ProviderButton[]>('/api/oidc/admin/providers/order', { method: 'PUT', body: { ids } }),
  /** Takes an account's link to a provider, with the operator's own password. */
  unlinkAccount: (accountId: number, providerId: number, current_password: string) =>
    api<void>(`/api/oidc/admin/accounts/${accountId}/links/${providerId}`, { method: 'DELETE', body: { current_password } }),
  authentik: (url: string, token: string) => api<AuthentikResult>('/api/oidc/authentik/setup', { method: 'POST', body: { url, token } }),
  backups: () => api<Backup[]>('/api/backups'),
  makeBackup: (note: string) => api<{ name: string }>('/api/backups', { method: 'POST', body: { note } }),
  checkBackup: (name: string) => api<BackupCheck>(`/api/backups/${encodeURIComponent(name)}/check`, { method: 'POST' }),
  restoreBackup: (name: string, password: string) =>
    api<BackupCheck>(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', body: { password } }),
  deleteBackup: (name: string, password: string) =>
    api<void>(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE', body: { password } }),
  /** The archive itself; the password is asked again (empty for an account that signs in through the provider). */
  downloadBackup: (name: string, password: string) =>
    api<Blob>(`/api/backups/${encodeURIComponent(name)}/download`, { method: 'POST', body: { password }, blob: true }),
  /** A backup from elsewhere (a move to a new server): the ZIP as the body, the password once more in a header. */
  uploadBackup: async (file: Blob, password: string): Promise<{ name: string }> => {
    const response = await fetch('/api/backups/upload', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/zip', 'X-Nexlore-Client': tabId(), 'X-Nexlore-Password': passwordHeader(password) },
      body: file,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(response.status, typeof data?.detail?.code === 'string' ? data.detail.code : 'internal_error')
    return data as { name: string }
  },
  /** The JSON file itself as the body. */
  uploadLanguage: async (code: string, file: Blob): Promise<AddedLanguage> => {
    const response = await fetch(`/api/locales/${encodeURIComponent(code)}`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Nexlore-Client': tabId() },
      body: file,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(response.status, typeof data?.detail?.code === 'string' ? data.detail.code : 'internal_error')
    return data as AddedLanguage
  },
  removeLanguage: (code: string) => api<void>(`/api/locales/${encodeURIComponent(code)}`, { method: 'DELETE' }),
}

// --- Public pages ---------------------------------------------------------------------------------------------------

export type ShareInfo = {
  id: number
  path: string
  folder: boolean
  link: string
  by: string | null
  created_at: string
  expires_at: string | null
  password: boolean
}
export type PublicState = {
  folder: boolean
  name: string
  password: boolean
  unlocked: boolean
  expires_at: string | null
  notes?: { path: string; title: string }[]
}
export type PublicLink = { kind: string; target: string; note: string | null; file: number | null }
export type PublicPage = { path: string; title: string; content: string; links: PublicLink[] }

export const shareApi = {
  create: (path: string, days: number | null, password: string) =>
    api<ShareInfo>('/api/shares', { method: 'POST', body: { path, days, password } }),
  of: (path: string) => api<ShareInfo[]>('/api/shares', { query: { path } }),
  covers: (path: string) => api<{ count: number }>('/api/shares/covers', { query: { path } }),
  withdraw: (id: number) => api<void>(`/api/shares/${id}`, { method: 'DELETE' }),
  state: (token: string) => api<PublicState>(`/api/public/${encodeURIComponent(token)}`),
  unlock: (token: string, password: string) => api<void>(`/api/public/${encodeURIComponent(token)}/unlock`, { method: 'POST', body: { password } }),
  page: (token: string, path?: string) => api<PublicPage>(`/api/public/${encodeURIComponent(token)}/page`, { query: { path } }),
}

/** A file a public page uses. */
export function publicFileUrl(token: string, id: number, download = false): string {
  return `/api/public/${encodeURIComponent(token)}/file/${id}${download ? '?download=1' : ''}`
}

// --- The graph -------------------------------------------------------------------------------------------------------

export type Cloud = 'folders' | 'tags' | 'topics'
export type GroupKind = 'space' | 'folder' | 'tag' | 'untagged' | 'topic' | 'recent' | 'unsorted' | 'bucket' | 'unlinked' | 'range'
/** id, parent, kind, name, notes below, daily notes below, x, y, radius, colour (-1 grey), key, zoom level from which
 * its own notes are drawn (their tiles). */
export type GroupRow = [number, number | null, GroupKind, string, number, number, number, number, number, number, string, number]
export type Overview = {
  status: 'ready' | 'building'
  version: number
  built?: string | null
  changed?: string | null
  groups: GroupRow[]
  /** Links between the notes of two groups: group, group, how many. */
  links: [number, number, number][]
  manage: boolean
  open_from: number
  tile: number
  working: boolean
}
/** id, group, x, y, radius, daily (1/0), title, path. */
export type TileNote = [number, number, number, number, number, number, string, string]
export type Tiles = {
  tiles: { level: number; x: number; y: number; notes: TileNote[] }[]
  links: [number, number][]
  /** Ends of those links outside the tiles: id and group (a line to one ends at its closed circle). */
  others: [number, number][]
}
/** id, path, title, distance in links. */
export type LocalNode = [number, string, string, number]

export const graphApi = {
  overview: (space: string, cloud: Cloud) => api<Overview>('/api/graph/overview', { query: { space, cloud } }),
  tiles: (space: string, cloud: Cloud, tiles: string[]) => api<Tiles>('/api/graph/tiles', { query: { space, cloud, t: tiles } }),
  /** Link counts between groups of two spaces (links written as `[[Space/Note]]`), readable ones only. */
  across: (cloud: Cloud) => api<{ links: [number, number, number][] }>('/api/graph/across', { query: { cloud } }),
  locate: (path: string, cloud: Cloud) =>
    api<{ id: number; x: number; y: number; group: number; level: number }>('/api/graph/locate', { query: { path, cloud } }),
  local: (path: string, depth: number, limit = 150) =>
    api<{ nodes: LocalNode[]; links: [number, number][] }>('/api/graph/local', { query: { path, depth, limit } }),
  topics: (space: string) => api<{ status: string }>('/api/graph/topics', { method: 'POST', query: { space } }),
}

// --- Everyday use (M6): tasks, the calendar, daily notes, templates, the options of a space ---------------------

export type TaskStatus = 'open' | 'done' | 'cancelled'
export type TaskWhen = 'overdue' | 'today' | 'week' | 'later' | 'none'
export type TaskItem = {
  id: number
  path: string
  title: string
  line: number
  /** The line as written: ticking it off sends it back, so the server can tell whether it is still there. */
  raw: string
  status: TaskStatus
  /** The character between the brackets: `/` is "in progress" in the Tasks plugin, still open. */
  mark: string
  text: string
  due: string | null
  scheduled: string | null
  start: string | null
  completed: string | null
  /** 0 lowest, 1 low, 2 none, 3 medium, 4 high, 5 highest. */
  priority: number
  recurrence: string | null
  tags: string[]
  /** The file as it was when listed; ticking off checks it. */
  file_hash?: string
}
export type TaskCounts = Record<'open' | 'done' | 'cancelled' | TaskWhen, number>
export type TaskList = { total: number; counts: TaskCounts; items: TaskItem[] }
export type TaskQuery = {
  today: string
  status?: 'open' | 'done' | 'cancelled' | 'all'
  when?: TaskWhen
  on?: string
  start?: string
  end?: string
  space?: string
  tag?: string
  q?: string
  offset?: number
  limit?: number
}
export type Toggled = {
  path: string; line: number; raw: string; hash: string; conflict: string | null; added: string | null
  /** A repetition the server does not read: ticked off, no next task. */
  recurrence_unknown?: boolean
}
export type CalendarDay = { daily: string[]; open: number; done: number; overdue: number }
export type SpaceOptions = { daily_folder: string; daily_template: string; template_folder: string; theme: string; daily_format: string }
/** Daily notes a space's settings miss: where they are and how they are named. */
export type DailyGuess = { daily_folder: string; daily_format: string; count: number }
export type Template = { path: string; title: string }

export const everydayApi = {
  tasks: (query: TaskQuery) => api<TaskList>('/api/tasks', { query }),
  toggle: (task: Pick<TaskItem, 'path' | 'line' | 'raw'> & { file_hash?: string }, done: boolean, today: string) =>
    api<Toggled>('/api/tasks/toggle', {
      method: 'POST',
      body: { path: task.path, line: task.line, raw: task.raw, done, today, hash: task.file_hash },
    }),
  calendar: (month: string, today: string, space?: string) =>
    api<{ month: string; days: Record<string, CalendarDay> }>('/api/calendar', { query: { month, today, space } }),
  /** The daily note of a date in a space: opened, or made from the space's template. */
  daily: (space: string, date: string) =>
    api<{ path: string; created: boolean; template_missing?: boolean }>('/api/daily', { method: 'POST', body: { space, date, now: readerNow() } }),
  templates: (space: string) => api<Template[]>('/api/templates', { query: { space } }),
  preview: (path: string, title: string) => api<{ content: string }>('/api/templates/preview', { query: { path, title, now: readerNow() } }),
  options: (space: string) => api<SpaceOptions>(`/api/spaces/${encodeURIComponent(space)}/options`),
  dailyGuess: (space: string) => api<DailyGuess | null>(`/api/spaces/${encodeURIComponent(space)}/daily-guess`),
  setOptions: (space: string, options: Partial<SpaceOptions>) =>
    api<SpaceOptions>(`/api/spaces/${encodeURIComponent(space)}/options`, { method: 'PUT', body: options }),
}

// --- Open to the outside (M7): MCP keys, drafts an AI proposed ----------------------------------------------------

export type McpLevel = 'read' | 'draft' | 'write'
/** `spaces`: the names of the spaces the key may see; null: every space the account may read. */
export type McpRight = 'allow' | 'ask' | 'deny'
export type McpGroup = 'read' | 'draft' | 'change' | 'risky'
export type McpKey = {
  id: number
  name: string
  level: McpLevel
  prefix: string
  created_at: string
  last_used_at: string | null
  spaces: string[] | null
  /** Rights per tool where the key differs from its group's default (block Y). */
  rights: Record<string, McpRight>
  /** `key` made here, `oauth` a connector that signed in. */
  kind: 'key' | 'oauth'
}
export type McpTool = { name: string; group: McpGroup; level: McpLevel; description: string }
export type McpTools = { tools: McpTool[]; defaults: Record<McpGroup, McpRight>; blocked: string[] }
export type McpRequest = {
  id: number
  key_name: string
  tool: string
  group: McpGroup
  description: string
  arguments: Record<string, unknown>
  status: 'waiting' | 'done' | 'failed' | 'declined' | 'expired'
  result: unknown
  created_at: string
  expires_at: string
  decided_at: string | null
}
export type ConsentInfo = { client_name: string; redirect_host: string; max_level: McpLevel; spaces: { id: number; name: string }[] }
export type DraftInfo = { id: number; path: string; title: string; new: boolean; key_name: string; reason: string; created_at: string }
export type DraftFull = DraftInfo & { content: string; current: string | null; changed: boolean }

export const mcpApi = {
  keys: () => api<{ allowed: boolean; max_level: McpLevel; keys: McpKey[] }>('/api/mcp/keys'),
  make: (name: string, level: McpLevel, spaces: number[] | null = null) =>
    api<{ key: McpKey; token: string }>('/api/mcp/keys', { method: 'POST', body: { name, level, spaces } }),
  revoke: (id: number) => api<void>(`/api/mcp/keys/${id}`, { method: 'DELETE' }),
  tools: () => api<McpTools>('/api/mcp/tools'),
  setRights: (id: number, rights: Record<string, McpRight>) => api<McpKey>(`/api/mcp/keys/${id}/rights`, { method: 'PUT', body: { rights } }),
  setBlocked: (tools: string[]) => api<McpTools>('/api/mcp/blocked', { method: 'PUT', body: { tools } }),
  requests: () => api<McpRequest[]>('/api/mcp/requests'),
  approve: (id: number, always: boolean) => api<McpRequest>(`/api/mcp/requests/${id}/approve`, { method: 'POST', body: { always } }),
  decline: (id: number) => api<McpRequest>(`/api/mcp/requests/${id}/decline`, { method: 'POST' }),
}

// --- API tokens for programs (n8n, nexdeck) ------------------------------------------------------------------------

export type ApiLevel = 'read' | 'write'
export type ApiToken = {
  id: number
  name: string
  level: ApiLevel
  prefix: string
  created_at: string
  last_used_at: string | null
  /** null: never runs out. */
  expires_at: string | null
  /** The operator blocked it for good. */
  blocked: boolean
  /** The spaces it may see, of those the account may read now; null: all of them. */
  spaces: string[] | null
}
/** Every token, for the operator: who it belongs to, never the token itself. */
export type AnyApiToken = Omit<ApiToken, 'spaces'> & { account: string; spaces: number | null }

export const apiTokensApi = {
  list: () => api<{ allowed: boolean; tokens: ApiToken[] }>('/api/api-tokens'),
  make: (name: string, level: ApiLevel, spaces: number[] | null, days: number | null) =>
    api<{ token: ApiToken; secret: string }>('/api/api-tokens', { method: 'POST', body: { name, level, spaces, days } }),
  remove: (id: number) => api<void>(`/api/api-tokens/${id}`, { method: 'DELETE' }),
  every: () => api<AnyApiToken[]>('/api/admin/api-tokens'),
  block: (id: number) => api<AnyApiToken>(`/api/admin/api-tokens/${id}/block`, { method: 'POST' }),
}

export type NotifyChoices = {
  email: boolean
  mention: boolean
  invite: boolean
  approval: boolean
  tasks: boolean
  tasks_time: string
  operator: boolean
  tokens: boolean
}
export type NotifyView = {
  choices: NotifyChoices
  webhook: { set: boolean; host: string }
  email: { possible: boolean; server: boolean; address: string }
  operator: boolean
}

/** The own notifications (block Z2). */
export const notifyApi = {
  get: () => api<NotifyView>('/api/me/notify'),
  save: (change: { choices?: Partial<NotifyChoices>; webhook?: string }) => api<NotifyView>('/api/me/notify', { method: 'PUT', body: change }),
  test: () => api<Record<string, string>>('/api/me/notify/test', { method: 'POST' }),
}

/** A connector signing in for MCP (OAuth, block Y): what it asks for, and the answer. */
export const oauthApi = {
  info: (query: Record<string, string>) => api<ConsentInfo>('/api/oauth/authorize', { query }),
  answer: (body: Record<string, unknown>) => api<{ redirect: string }>('/api/oauth/authorize', { method: 'POST', body }),
}

export const draftsApi = {
  list: (path?: string) => api<DraftInfo[]>('/api/drafts', { query: { path } }),
  one: (id: number) => api<DraftFull>(`/api/drafts/${id}`),
  accept: (id: number) => api<{ path: string; conflict: string | null }>(`/api/drafts/${id}/accept`, { method: 'POST' }),
  discard: (id: number) => api<void>(`/api/drafts/${id}`, { method: 'DELETE' }),
}
