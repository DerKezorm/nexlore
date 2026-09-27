/**
 * How a version of a note says where it came from. A link rewritten because somebody renamed a note names who did
 * it: the note may lie in a space that person cannot even see ("rename by anna"), and its owner should know why it
 * changed.
 */
import type { TFunction } from 'i18next'

import type { VersionInfo } from '../api/client'

export function versionSource(version: Pick<VersionInfo, 'source' | 'author'>, t: TFunction): string {
  if (version.source === 'rename' && version.author) return t('note.source.renameBy', { name: version.author })
  return t(`note.source.${version.source}`, { defaultValue: version.source })
}
