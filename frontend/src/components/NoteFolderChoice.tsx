/**
 * Renaming a note: when the attachment folder beside it holds a folder named after it (a name pattern like
 * `{note}/{filename}` makes one), the rename offers to give that folder the new name too.
 */
import { useTranslation } from 'react-i18next'

export function NoteFolderChoice({ folder, checked, onChange }: { folder: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const { t } = useTranslation()
  // The attachment folder and the note's folder in it: `Attachments/Shopping`.
  const shown = folder.split('/').slice(-2).join('/')
  return (
    <label className="flex items-start gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-mist-200" data-testid="rename-folder">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 accent-accent-500" />
      <span>{t('note.renameFolder', { folder: shown })}</span>
    </label>
  )
}
