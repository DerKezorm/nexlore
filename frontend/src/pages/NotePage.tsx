/** One note: reading view or editor, with backlinks, links and attachments on the right. */
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { NoteEditor } from '../components/NoteEditor'
import { Sidebar } from '../components/Sidebar'
import { Symbol } from '../components/Symbol'
import { locale } from '../i18n'
import { formatDate, renderMarkdown, snippetAround } from '../lib/markdown'
import { ancestry } from '../lib/vault'
import { DRAFT_ACCESS, ME } from '../mock/notes'
import { useStore } from '../state/store'

export function NotePage() {
  const { id = 'mein-wissen-projekte-app-ideen-notiz-app' } = useParams()
  const { t } = useTranslation()
  const { vault, updateBody, acceptDraft } = useStore()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [editingId, setEditingId] = useState(id)
  const note = vault.notes.get(id)

  // A different note starts in the reading view again.
  if (editingId !== id) {
    setEditingId(id)
    setEditing(false)
  }

  const titles = useMemo(() => [...vault.notes.values()].map((n) => n.title).sort((a, b) => a.localeCompare(b, locale())), [vault])
  const html = useMemo(() => (note ? renderMarkdown(note.body, vault) : ''), [note, vault])

  if (!note) {
    return (
      <>
        <Sidebar activeNote={null} onNote={(next) => navigate(`/note/${encodeURIComponent(next)}`)} />
        <main className="flex flex-1 items-center justify-center text-mist-500">{t('note.notFound')}</main>
      </>
    )
  }

  const chain = ancestry(vault, note.id)
  const backlinks = vault.backlinks.get(note.id) ?? []
  const outgoing = vault.outgoing.get(note.id) ?? []
  const locked = !!note.lockedBy && note.lockedBy !== ME
  const open = (next: string) => navigate(`/note/${encodeURIComponent(next)}`)

  return (
    <>
      <Sidebar key={'tree-' + note.id} activeNote={note.id} onNote={open} />
      <main className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="flex shrink-0 items-center gap-3 border-b border-ink-700/80 px-6 py-2.5">
            <div className="min-w-0 flex-1 truncate text-sm text-mist-500">
              {chain.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && <span className="px-1.5 text-mist-600">›</span>}
                  <span className={i === 0 ? 'font-medium text-mist-300' : ''}>{c.name}</span>
                </span>
              ))}
            </div>
            <div className="flex items-center rounded-full border border-ink-700 bg-ink-850 p-0.5 text-sm" role="group" aria-label={t('note.view')}>
              <button
                type="button"
                onClick={() => setEditing(false)}
                aria-pressed={!editing}
                className={'inline-flex items-center gap-1.5 rounded-full px-3 py-1 ' + (!editing ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400 hover:text-mist-100')}
              >
                <Symbol name="eye" className="h-3.5 w-3.5" /> {t('note.read')}
              </button>
              <button
                type="button"
                onClick={() => !locked && setEditing(true)}
                aria-pressed={editing}
                disabled={locked}
                title={locked ? t('note.lockedTitle', { name: note.lockedBy }) : undefined}
                className={'inline-flex items-center gap-1.5 rounded-full px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40 ' + (editing ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400 hover:text-mist-100')}
              >
                <Symbol name="pencil" className="h-3.5 w-3.5" /> {t('note.edit')}
              </button>
            </div>
            <Link to={`/?focus=${encodeURIComponent(note.id)}`} className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
              <Symbol name="graph" className="h-3.5 w-3.5" /> {t('note.inGraph')}
            </Link>
          </div>

          {/* Banners */}
          {locked && (
            <div className="mx-6 mt-4 flex items-center gap-3 rounded-xl border border-warn-500/30 bg-warn-500/10 px-4 py-2.5 text-sm text-warn-500">
              <Symbol name="lock" />
              <span className="flex-1">{t('note.lockedBanner', { name: note.lockedBy })}</span>
            </div>
          )}
          {note.aiDraft && (
            <div className="mx-6 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-ai-500/30 bg-ai-500/10 px-4 py-2.5 text-sm text-ai-500">
              <Symbol name="sparkle" />
              <span className="flex-1">
                <strong>{t('note.draftTitle')}</strong> {t('note.draftBanner', { access: DRAFT_ACCESS, when: formatDate(note.updated) })}
              </span>
              <button type="button" onClick={() => acceptDraft(note.id)} className="rounded-full bg-ai-500 px-3 py-1 text-xs font-semibold text-ink-950 hover:opacity-90">
                {t('note.accept')}
              </button>
            </div>
          )}

          {/* Body */}
          <div className="nn-scroll min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-6">
              <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-mist-500">
                <span>{note.author === ME ? t('note.byYou') : t('note.byOther', { name: note.author })}</span>
                <span>·</span>
                <span>{t('note.changed', { when: formatDate(note.updated) })}</span>
                <span>·</span>
                <span className="font-mono text-[11px]">{[...note.path, note.title].join('/')}.md</span>
              </div>
              {editing ? (
                <NoteEditor key={note.id} value={note.body} titles={titles} onChange={(body) => updateBody(note.id, body)} />
              ) : (
                <article
                  className="nn-prose"
                  onClick={(e) => {
                    const target = (e.target as HTMLElement).closest('a[data-note]')
                    if (target) open(target.getAttribute('data-note')!)
                  }}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Right column */}
        <aside className="nn-scroll hidden w-72 shrink-0 overflow-y-auto border-l border-ink-700/80 px-4 py-4 xl:block">
          <Section symbol="backlink" title={t('note.backlinks')} count={backlinks.length}>
            {backlinks.length === 0 && <p className="text-sm text-mist-600">{t('note.noBacklinks')}</p>}
            {backlinks.map((from) => {
              const other = vault.notes.get(from)!
              return (
                <button key={from} type="button" onClick={() => open(from)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink-850">
                  <span className="block text-sm font-medium text-mist-200">{other.title}</span>
                  <span className="line-clamp-2 block text-xs text-mist-500">{snippetAround(other.body, note.title) || other.path.join(' › ')}</span>
                </button>
              )
            })}
          </Section>
          <Section symbol="link" title={t('note.outgoing')} count={outgoing.length}>
            {outgoing.map((to) => (
              <button key={to} type="button" onClick={() => open(to)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-mist-300 hover:bg-ink-850">
                <span className="h-2 w-2 rounded-full" style={{ background: vault.home.get(to)!.color }} />
                <span className="truncate">{vault.notes.get(to)!.title}</span>
              </button>
            ))}
          </Section>
          <Section symbol="clip" title={t('note.attachments')} count={note.attachments?.length ?? 0}>
            {(note.attachments ?? []).map((file) => (
              <div key={file.name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-mist-300">
                <Symbol name={file.kind === 'image' ? 'image' : file.kind === 'pdf' ? 'pdf' : 'file'} className="h-4 w-4 text-mist-500" />
                <span className="flex-1 truncate">{file.name}</span>
                <span className="text-xs text-mist-600">{file.size}</span>
              </div>
            ))}
            <button type="button" className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-ink-600 px-2 py-2 text-xs text-mist-500 hover:border-accent-500/60 hover:text-mist-200" title={t('common.noFunction')}>
              <Symbol name="upload" className="h-3.5 w-3.5" /> {t('note.dropFile')}
            </button>
          </Section>
        </aside>
      </main>
    </>
  )
}

function Section({ symbol, title, count, children }: { symbol: 'backlink' | 'link' | 'clip'; title: string; count: number; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 flex items-center gap-2 px-2 text-[11px] font-semibold tracking-wider text-mist-500 uppercase">
        <Symbol name={symbol} className="h-3.5 w-3.5" />
        {title}
        <span className="ml-auto text-mist-600 tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  )
}
