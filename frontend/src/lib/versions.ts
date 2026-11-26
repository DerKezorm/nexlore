/**
 * How a version of a note says where it came from. A link rewritten because somebody renamed a note names who did
 * it: the note may lie in a space that person cannot even see ("rename by anna"), and its owner should know why it
 * changed. An AI program's change names the key or program it came with ("MCP · Agent").
 */
import type { TFunction } from 'i18next'

import type { VersionInfo } from '../api/client'

export function versionSource(version: Pick<VersionInfo, 'source' | 'author'> & Partial<Pick<VersionInfo, 'key_name'>>, t: TFunction): string {
  if (version.source === 'rename' && version.author) return t('note.source.renameBy', { name: version.author })
  // An AI program names its key, as in nexnotes (MCP decision 15); versions from before say "AI (MCP)".
  if (version.source === 'mcp' && version.key_name) return t('note.source.mcpKey', { key: version.key_name })
  return t(`note.source.${version.source}`, { defaultValue: version.source })
}
