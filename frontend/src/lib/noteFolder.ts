/** Renaming a note: the folder named after it in the attachment folder beside it (see `NoteFolderChoice`). */
import { useEffect, useState } from 'react'

import { vaultApi } from '../api/client'

/** The folder named after the note at `path` in the attachment folder beside it, or null; asked only while `path` is set. */
export function useNoteFolder(path: string | null): string | null {
  const [folder, setFolder] = useState<string | null>(null)
  useEffect(() => {
    setFolder(null)
    if (!path) return
    let live = true
    vaultApi.noteFolder(path).then(
      (found) => live && setFolder(found.folder),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [path])
  return folder
}
