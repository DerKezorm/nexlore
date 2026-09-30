/** Folders made on the way: a template goes into the templates folder, which a new space has not got yet. */
import { vaultApi } from '../api/client'

/** Makes `path` (a vault path) and the folders on its way where they are missing. */
export async function ensureFolder(path: string): Promise<void> {
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    await vaultApi.createFolder(parts.slice(0, i).join('/'), parts[i], true)
  }
}

/** What a template starts with: its placeholders, filled in when a note is made from it. */
export const TEMPLATE_START = '# {{title}}\n\n{{date}}\n\n'
