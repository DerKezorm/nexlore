/**
 * What goes into the trash along with a note, file or folder without being in it: public pages showing it (they
 * cannot be reached until it comes back), and canvases it lies on (they keep a card that says it is gone, and show it
 * again when it comes back). Said in both trash dialogs, the note page's and the sidebar's.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { canvasApi, shareApi } from '../api/client'
import { baseName } from '../lib/vault'

const WARNING = 'mt-3 rounded-lg border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-sm text-warn-500'

export function TrashWarnings({ path, folder }: { path: string; folder: boolean }) {
  const { t } = useTranslation()
  const [shared, setShared] = useState(0)
  const [canvases, setCanvases] = useState<{ count: number; paths: string[] }>({ count: 0, paths: [] })
  useEffect(() => {
    let live = true
    shareApi.covers(path).then(
      (found) => live && setShared(found.count),
      () => undefined,
    )
    canvasApi.lyingOn(path).then(
      (found) => live && setCanvases(found),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [path])
  const names = canvases.paths.map((found) => `„${baseName(found).replace(/\.canvas$/i, '')}“`).join(', ') + (canvases.count > canvases.paths.length ? ' …' : '')
  return (
    <>
      {shared > 0 && <p className={WARNING} data-testid="shared-warning">{t('actions.sharedTrash', { count: shared })}</p>}
      {canvases.count > 0 && (
        <p className={WARNING} data-testid="canvas-warning">
          {t(folder ? 'actions.canvasTrashFolder' : 'actions.canvasTrash', { count: canvases.count, names })}
        </p>
      )}
    </>
  )
}
