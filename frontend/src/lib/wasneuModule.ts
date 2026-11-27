/**
 * nexlore's side of the shared module wasneu 0.1.0 (`vendor/nexwasneu`): the texts live in `backend/app/whatsnew`, the
 * server serves them under `/api/whats-new` (the module's default), and every call carries the tab's name
 * (`X-Nexlore-Client`), as every call of nexlore does.
 */
import { tabId } from '../api/client'
import type { Fetcher } from '../vendor/nexwasneu'

export const whatsNewFetch: Fetcher = (path, init) =>
  fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'X-Nexlore-Client': tabId() } })

export const LOGO = '/logo.svg?v=2'
