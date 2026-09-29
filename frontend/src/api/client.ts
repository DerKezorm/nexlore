/**
 * The server's vault API. Every call names this browser tab in `X-Nexlore-Client`: an edit lock belongs to a tab,
 * so the same person in two tabs cannot type over themselves.
 *
 * Errors come back as `ApiError` with the server's code; the page builds its sentence from `errors.byCode`.
 */

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
  /** The theme its managers set for the space's notes; empty for none. */
  theme?: string
}
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
export type Backlink = { path: string; title: string; line: number; kind: string; context?: string | null }
export type Links = { outgoing: Outgoing[]; backlinks: Backlink[] }
export type Hit = { path: string; title: string; snippet: string }
export type Found = { path: string; title: string; link?: string | null; alias?: string | null }
export type FolderEntry = { name: string; path: string; notes: number }
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
    api<NoteData>('/api/notes', { method: 'POST', body: { folder, title, content, template } }),
  /** `along`: files only this note uses that go into the trash with it (see `own`). */
  createFolder: (parent: string, name: string) => api<{ path: string }>('/api/folders', { method: 'POST', body: { parent, name } }),
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

// --- Accounts, rights, invitations -----------------------------------------------------------------------------------

export type Account = {
  id: number
  name: string
  role: 'operator' | 'member'
  sign_in: 'password' | 'oidc'
  email: string
  language: string
  oidc_linked: boolean
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
  second_factor_setup_required: boolean
  /** The editor offers AI: the operator allows it and the account switched its own service on. */
  ai_ready?: boolean
  appearance?: Appearance
  /** The colours of the chosen theme; null: nexlore's own. */
  theme_colours?: Colours | null
  /** The own CSS snippets in force (empty unless the operator allows own CSS). */
  own_css?: string[]
}
export type AdminAccount = Account & { spaces: number; locked: boolean }
export type SetupState = { needs_setup: boolean; signed_in: boolean; version: string; min_password: number }
export type Methods = { password: boolean; oidc: boolean; oidc_name: string }
export type Member = { name: string; role: Role; you: boolean }
export type Invite = { id: number; role: string; email: string; by: string | null; created_at: string; expires_at: string }
export type NewInvite = Invite & { link: string; sent: boolean }
export type Members = { space: string; members: Member[]; invites: Invite[]; role: Role | null }
export type InviteOffer = { space: string | null; role: Role | null; min_password: number; signed_in_as: string | null }
export type AdminSpace = { name: string; members: number; managers: string[]; role: Role | null }

export const authApi = {
  setupState: () => api<SetupState>('/api/setup'),
  setup: (name: string, password: string, language: string) =>
    api<Account>('/api/setup', { method: 'POST', body: { name, password, language } }),
  methods: () => api<Methods>('/api/auth/methods'),
  /** Signed in, or `second_factor`: the password was right, the code from the app comes next. */
  login: (name: string, password: string) =>
    api<Account | { second_factor: true }>('/api/auth/login', { method: 'POST', body: { name, password } }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  logoutEverywhere: () => api<void>('/api/auth/logout-all', { method: 'POST' }),
  me: () => api<Me>('/api/auth/me'),
  changePassword: (current: string, next: string) => api<void>('/api/auth/password', { method: 'PUT', body: { current, new: next } }),
  setLanguage: (language: string) => api<Account>('/api/me/language', { method: 'PUT', body: { language } }),
  setAppearance: (changes: Partial<Appearance>) => api<Appearance>('/api/me/appearance', { method: 'PUT', body: changes }),
  linkStart: (password: string) => api<{ url: string }>('/api/oidc/link/start', { method: 'POST', body: { password } }),
  unlink: () => api<void>('/api/oidc/link', { method: 'DELETE' }),
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
  setMember: (space: string, name: string, role: Role) =>
    api<Member>(`/api/spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(name)}`, { method: 'PUT', body: { role } }),
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
  plugin_upload_allowed: boolean
  ai_allowed: boolean
  custom_css_allowed: boolean
}
export type ServerSettingsChange = Partial<Omit<ServerSettings, 'smtp_password_set'>> & { smtp_password?: string }
export type FileSettings = { attachment_folder: string; upload_max_mb: number; quota_mb: number; strip_location: boolean }
export type OidcConfig = {
  configured: boolean
  issuer: string
  client_id: string
  provider_name: string
  auto_create: boolean
  redirect_uri: string
}
export type OidcChange = { issuer: string; client_id: string; client_secret: string; provider_name: string; auto_create: boolean }
export type AuthentikResult = { steps: { key: string; ok: boolean; detail: string }[]; client_id: string; issuer: string }
export type Backup = { name: string; size: number; created: string; kind: string; note: string; notes: number; files: number; version: string }
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

export type Favorite = { path: string; kind: 'note' | 'folder' | 'file'; title: string }

export const favoritesApi = {
  list: () => api<Favorite[]>('/api/favorites'),
  set: (path: string, on: boolean) => api<void>('/api/favorites', { method: 'PUT', body: { path, on } }),
}

// --- New since the last visit and proposals (routers/news.py, routers/proposals.py) --------------------------------

export type NewNote = { path: string; title: string; changed_at: string; author: string }
export type Proposal = {
  id: number; path: string; title: string; by: string; message: string; status: 'open' | 'taken' | 'declined'
  created_at: string; decided_at: string | null; decided_by: string | null; content: string | null
}

export const newsApi = {
  list: () => api<{ count: number; notes: NewNote[] }>('/api/news'),
  seenAll: () => api<void>('/api/news/seen', { method: 'POST' }),
}

export const proposalsApi = {
  propose: (path: string, content: string, baseHash: string, message: string) =>
    api<Proposal>('/api/proposals', { method: 'POST', body: { path, content, base_hash: baseHash, message } }),
  forNote: (path: string) => api<Proposal[]>('/api/proposals/note', { query: { path } }),
  overview: () => api<{ waiting: Proposal[]; mine: Proposal[] }>('/api/proposals'),
  take: (id: number) => api<{ path: string; conflict: string | null }>(`/api/proposals/${id}/take`, { method: 'POST' }),
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
  problems: string[]
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
export type AiState = { allowed: boolean; ready: boolean; access: AiAccess; tones: string[] }
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
  clear: () => api<{ removed: number }>('/api/ai/events', { method: 'DELETE' }),
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
  spaces: () => api<AdminSpace[]>('/api/admin/spaces'),
  shares: () => api<ShareInfo[]>('/api/admin/shares'),
  oidc: () => api<OidcConfig>('/api/oidc/config'),
  saveOidc: (values: OidcChange) => api<OidcConfig>('/api/oidc/config', { method: 'PUT', body: values }),
  removeOidc: () => api<void>('/api/oidc/config', { method: 'DELETE' }),
  authentik: (url: string, token: string) => api<AuthentikResult>('/api/oidc/authentik/setup', { method: 'POST', body: { url, token } }),
  backups: () => api<Backup[]>('/api/backups'),
  makeBackup: (note: string) => api<{ name: string }>('/api/backups', { method: 'POST', body: { note } }),
  checkBackup: (name: string) => api<BackupCheck>(`/api/backups/${encodeURIComponent(name)}/check`, { method: 'POST' }),
  restoreBackup: (name: string) => api<BackupCheck>(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' }),
  deleteBackup: (name: string) => api<void>(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** The archive itself; the password is asked again (empty for an account that signs in through the provider). */
  downloadBackup: (name: string, password: string) =>
    api<Blob>(`/api/backups/${encodeURIComponent(name)}/download`, { method: 'POST', body: { password }, blob: true }),
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
}
export type TaskCounts = Record<'open' | 'done' | TaskWhen, number>
export type TaskList = { total: number; counts: TaskCounts; items: TaskItem[] }
export type TaskQuery = {
  today: string
  status?: 'open' | 'done' | 'all'
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
export type Toggled = { path: string; line: number; raw: string; hash: string; conflict: string | null; added: string | null }
export type CalendarDay = { daily: string[]; open: number; done: number; overdue: number }
export type SpaceOptions = { daily_folder: string; daily_template: string; template_folder: string; theme: string }
export type Template = { path: string; title: string }

export const everydayApi = {
  tasks: (query: TaskQuery) => api<TaskList>('/api/tasks', { query }),
  toggle: (task: Pick<TaskItem, 'path' | 'line' | 'raw'>, done: boolean, today: string) =>
    api<Toggled>('/api/tasks/toggle', { method: 'POST', body: { path: task.path, line: task.line, raw: task.raw, done, today } }),
  calendar: (month: string, today: string, space?: string) =>
    api<{ month: string; days: Record<string, CalendarDay> }>('/api/calendar', { query: { month, today, space } }),
  /** The daily note of a date in a space: opened, or made from the space's template. */
  daily: (space: string, date: string) => api<{ path: string; created: boolean }>('/api/daily', { method: 'POST', body: { space, date } }),
  templates: (space: string) => api<Template[]>('/api/templates', { query: { space } }),
  preview: (path: string, title: string) => api<{ content: string }>('/api/templates/preview', { query: { path, title } }),
  options: (space: string) => api<SpaceOptions>(`/api/spaces/${encodeURIComponent(space)}/options`),
  setOptions: (space: string, options: Partial<SpaceOptions>) =>
    api<SpaceOptions>(`/api/spaces/${encodeURIComponent(space)}/options`, { method: 'PUT', body: options }),
}

// --- Open to the outside (M7): MCP keys, drafts an AI proposed ----------------------------------------------------

export type McpLevel = 'read' | 'draft' | 'write'
/** `spaces`: the names of the spaces the key may see; null: every space the account may read. */
export type McpKey = { id: number; name: string; level: McpLevel; prefix: string; created_at: string; last_used_at: string | null; spaces: string[] | null }
export type DraftInfo = { id: number; path: string; title: string; new: boolean; key_name: string; reason: string; created_at: string }
export type DraftFull = DraftInfo & { content: string; current: string | null; changed: boolean }

export const mcpApi = {
  keys: () => api<{ allowed: boolean; max_level: McpLevel; keys: McpKey[] }>('/api/mcp/keys'),
  make: (name: string, level: McpLevel, spaces: number[] | null = null) =>
    api<{ key: McpKey; token: string }>('/api/mcp/keys', { method: 'POST', body: { name, level, spaces } }),
  revoke: (id: number) => api<void>(`/api/mcp/keys/${id}`, { method: 'DELETE' }),
}

export const draftsApi = {
  list: (path?: string) => api<DraftInfo[]>('/api/drafts', { query: { path } }),
  one: (id: number) => api<DraftFull>(`/api/drafts/${id}`),
  accept: (id: number) => api<{ path: string; conflict: string | null }>(`/api/drafts/${id}/accept`, { method: 'POST' }),
  discard: (id: number) => api<void>(`/api/drafts/${id}`, { method: 'DELETE' }),
}
