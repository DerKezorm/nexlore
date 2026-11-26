/** nexlore's client for the routes of the shared module verbinden (`/api/connect`): the tab in every request. */
import { api } from '../api/client'
import type { VerbindenRequest } from '../vendor/nexverbinden'

export const connectRequest: VerbindenRequest = <T,>(path: string, init: Parameters<VerbindenRequest>[1] = {}) =>
  api<T>(path, { method: init.method, body: init.body } as Parameters<typeof api>[1])

/** Where the pages send the browser; an object, so that a test sees it without leaving the page. */
export const leave = { to: (address: string) => window.location.assign(address) }
