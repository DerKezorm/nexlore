/**
 * nexlore's side of the shared device module geraete 0.1.0 (`vendor/nexgeraete`): where its browser routes are mounted
 * (`/api/devices`, beside the ways of 1.16.0 under `/api/app-pairing` and `/api/app-devices`) and nexlore's client for
 * its cards, with the tab in every request and the error's `code`.
 */
import { api } from '../api/client'
import type { DeviceRequest } from '../vendor/nexgeraete'

export const DEVICES_API = '/api/devices'

export const deviceRequest: DeviceRequest = <T,>(path: string, init: Parameters<DeviceRequest>[1] = {}) =>
  api<T>(path, { method: init.method, query: init.query, body: init.body } as Parameters<typeof api>[1])
