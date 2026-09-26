/** All attachments across the vault, with the note each one belongs to. */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { Symbol } from '../components/Symbol'
import { formatDate } from '../lib/markdown'
import { useStore } from '../state/store'

export function FilesPage() {
  const { t } = useTranslation()
  const { vault } = useStore()
  const [query, setQuery] = useState('')

  const files = useMemo(() => {
    const all = [...vault.notes.values()].flatMap((note) => (note.attachments ?? []).map((file) => ({ file, note })))
    const q = query.trim().toLowerCase()
    return q ? all.filter(({ file, note }) => file.name.toLowerCase().includes(q) || note.title.toLowerCase().includes(q)) : all
  }, [vault, query])

  return (
    <main className="nn-scroll flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">{t('files.title')}</h1>
            <p className="mt-1 text-sm text-mist-500">{t('files.intro')}</p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-850 px-3">
            <Symbol name="search" className="h-4 w-4 text-mist-500" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('files.filter')} className="h-9 w-48 bg-transparent text-sm outline-none placeholder:text-mist-600" />
          </div>
          <button type="button" className="inline-flex items-center gap-2 rounded-full bg-accent-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-400" title={t('common.noFunction')}>
            <Symbol name="upload" /> {t('files.upload')}
          </button>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-700 text-left text-xs text-mist-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t('files.file')}</th>
                <th className="px-4 py-2.5 font-medium">{t('files.belongsTo')}</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">{t('files.space')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('files.size')}</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">{t('files.changed')}</th>
              </tr>
            </thead>
            <tbody>
              {files.map(({ file, note }) => (
                <tr key={note.id + file.name} className="border-b border-ink-700/60 last:border-0 hover:bg-ink-850">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-800 text-mist-400">
                        <Symbol name={file.kind === 'image' ? 'image' : file.kind === 'pdf' ? 'pdf' : 'file'} />
                      </span>
                      <span className="font-medium text-mist-100">{file.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/note/${encodeURIComponent(note.id)}`} className="text-accent-400 hover:underline">
                      {note.title}
                    </Link>
                  </td>
                  <td className="hidden px-4 py-3 text-mist-400 md:table-cell">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: vault.home.get(note.id)!.color }} />
                      {note.path.join(' › ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-mist-400 tabular-nums">{file.size}</td>
                  <td className="hidden px-4 py-3 text-right text-mist-500 sm:table-cell">{formatDate(note.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {files.length === 0 && <p className="px-4 py-10 text-center text-sm text-mist-500">{t('files.none')}</p>}
        </div>

        <div className="mt-4 flex items-center justify-center gap-2 rounded-2xl border border-dashed border-ink-600 px-4 py-8 text-sm text-mist-500">
          <Symbol name="upload" /> {t('files.drop')}
        </div>
      </div>
    </main>
  )
}
