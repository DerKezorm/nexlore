/**
 * Settings → Look → Own CSS: snippets as in Obsidian, named and switched on one by one, for the own account only. The
 * server reads every snippet with a CSS parser and refuses what could load anything or leave the page; the operator
 * decides whether own CSS is allowed at all.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, cssApi, type Snippet } from '../../api/client'
import { errorText } from '../../lib/errors'
import { useAuth } from '../../state/auth'
import { Symbol } from '../Symbol'

type Problem = { line: number; what: string }

export function SnippetsCard() {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [state, setState] = useState<{ allowed: boolean; snippets: Snippet[] } | null>(null)
  const [editing, setEditing] = useState<{ id: number | null; name: string; css: string } | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await cssApi.list())
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const after = async () => {
    await load()
    // The snippets in force come with the own account; the page takes them from there.
    await refresh()
  }
  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'bad_css') setProblems((error.values.problems as Problem[]) ?? [])
    else setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
  }
  const save = async () => {
    if (!editing) return
    setProblems([])
    setProblem(null)
    try {
      if (editing.id === null) await cssApi.create(editing.name.trim(), editing.css)
      else await cssApi.change(editing.id, { name: editing.name.trim(), css: editing.css })
      setEditing(null)
      await after()
    } catch (error) {
      fail(error)
    }
  }
  const toggle = async (snippet: Snippet) => {
    // At once on the screen; the server's answer follows (and puts it back if it refused).
    setState((current) => current && { ...current, snippets: current.snippets.map((item) => (item.id === snippet.id ? { ...item, enabled: !item.enabled } : item)) })
    try {
      await cssApi.change(snippet.id, { enabled: !snippet.enabled })
      await after()
    } catch (error) {
      fail(error)
      await load()
    }
  }
  const remove = async (snippet: Snippet) => {
    try {
      await cssApi.remove(snippet.id)
      await after()
    } catch (error) {
      fail(error)
    }
  }
  if (!state) return null

  return (
    <section className="space-y-4 rounded-2xl border border-ink-700 bg-ink-850/60 p-5" data-testid="snippets">
      <div className="flex flex-wrap items-start gap-3">
        <span className="rounded-lg bg-accent-500/10 p-2 text-accent-400"><Symbol name="code" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-mist-100">{t('snippets.title')}</h2>
          <p className="text-sm text-mist-400">{t('snippets.text')}</p>
        </div>
        {state.allowed && !editing && (
          <button type="button" onClick={() => setEditing({ id: null, name: t('snippets.newName'), css: '' })} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent hover:bg-accent-400">
            {t('snippets.new')}
          </button>
        )}
      </div>
      {!state.allowed && <p className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-mist-400">{t('snippets.notAllowed')}</p>}
      {editing && (
        <div className="space-y-2 rounded-xl border border-ink-700 bg-ink-900 p-4" data-testid="snippet-editor">
          <input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} maxLength={80} aria-label={t('snippets.name')} className="h-8 w-64 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-sm" />
          <textarea
            value={editing.css}
            onChange={(event) => setEditing({ ...editing, css: event.target.value })}
            spellCheck={false}
            aria-label={t('snippets.css')}
            placeholder=".nn-prose h1 { letter-spacing: -0.02em; }"
            className="h-48 w-full rounded-lg border border-ink-700 bg-ink-950 p-2.5 font-mono text-xs text-mist-100"
          />
          {problems.length > 0 && (
            <ul role="alert" className="space-y-0.5 text-sm text-bad-500">
              {problems.map((item, index) => (
                <li key={index}>{t('snippets.problem', { line: item.line, what: item.what })}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-mist-500">{t('snippets.rules')}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setEditing(null); setProblems([]) }} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-800">{t('common.cancel')}</button>
            <button type="button" disabled={!editing.name.trim()} onClick={() => void save()} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40">{t('common.save')}</button>
          </div>
        </div>
      )}
      {state.snippets.length > 0 && (
        <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
          {state.snippets.map((snippet) => (
            <li key={snippet.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input type="checkbox" checked={snippet.enabled} disabled={!state.allowed} onChange={() => void toggle(snippet)} className="accent-accent-500" />
                <span className="truncate text-mist-200">{snippet.name}</span>
              </label>
              {state.allowed && (
                <button type="button" onClick={() => setEditing({ id: snippet.id, name: snippet.name, css: snippet.css })} className="rounded-full px-2 py-0.5 text-xs text-mist-400 hover:bg-ink-800 hover:text-mist-100">{t('themes.edit')}</button>
              )}
              <button type="button" onClick={() => void remove(snippet)} className="rounded-full px-2 py-0.5 text-xs text-mist-400 hover:bg-ink-800 hover:text-mist-100">{t('themes.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p role="alert" className="text-sm text-bad-500">{problem}</p>}
    </section>
  )
}
