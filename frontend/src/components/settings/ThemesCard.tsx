/**
 * Settings → Look → Themes: nexlore's own, the seven that come along, the ones others share, the own ones. A click
 * chooses one for the own account; an own theme is made, changed, shared or taken in from a file here. While a theme
 * is edited the whole page shows it, so the colours are judged where they are used.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, themesApi, type ThemeList, type ThemeRow } from '../../api/client'
import { errorText } from '../../lib/errors'
import { applyThemeColours, NEXLORE_COLOURS, readThemeFile, themeFile, TOKEN_GROUPS, weakSpots, type Colours, type Palette, type Token } from '../../lib/themes'
import { useAuth } from '../../state/auth'
import { Symbol } from '../Symbol'
import { CalloutsEditor } from './CalloutsEditor'
import type { Callouts } from '../../lib/callouts'

type Full = Required<Record<'dark' | 'light', Required<Palette>>> & { callouts?: Callouts }

function full(colours: Colours | null | undefined): Full {
  return {
    dark: { ...NEXLORE_COLOURS.dark, ...(colours?.dark ?? {}) },
    light: { ...NEXLORE_COLOURS.light, ...(colours?.light ?? {}) },
    ...(colours?.callouts && Object.keys(colours.callouts).length ? { callouts: colours.callouts } : {}),
  }
}

function Swatch({ colours }: { colours: Colours | null }) {
  const all = full(colours)
  return (
    <span className="grid h-14 grid-cols-2 overflow-hidden rounded-t-xl">
      {(['dark', 'light'] as const).map((mode) => (
        <span key={mode} className="flex items-end gap-1 p-2" style={{ background: all[mode].bg }}>
          <span className="h-3.5 w-3.5 rounded-full" style={{ background: all[mode].accent }} />
          <span className="h-3.5 w-3.5 rounded-full" style={{ background: all[mode].text }} />
        </span>
      ))}
    </span>
  )
}

type Draft = { id: number | null; name: string; colours: Full; shared: boolean }

export function ThemesCard() {
  const { t } = useTranslation()
  const { me, setAppearance } = useAuth()
  const [list, setList] = useState<ThemeList | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [mode, setMode] = useState<'dark' | 'light'>('dark')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const chosen = me?.appearance?.theme ?? 'nexlore'

  const load = useCallback(async () => {
    try {
      setList(await themesApi.list())
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  // While editing, the page shows the draft; leaving the editor brings back the theme in force.
  const restore = () => applyThemeColours(me?.theme_colours ?? null)
  const leaving = useRef({ drafting: false, inForce: me?.theme_colours ?? null })
  useEffect(() => {
    leaving.current.drafting = !!draft
    leaving.current.inForce = me?.theme_colours ?? null
    if (draft) applyThemeColours(draft.colours)
  }, [draft, me?.theme_colours])
  // Leaving the page with the editor open: back to the theme in force (and only then).
  useEffect(() => {
    const state = leaving.current
    return () => {
      if (state.drafting) applyThemeColours(state.inForce)
    }
  }, [])

  const fail = (error: unknown) => setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
  const choose = async (ref: string) => {
    setProblem(null)
    try {
      await setAppearance({ theme: ref })
    } catch (error) {
      fail(error)
    }
  }
  const edit = (row: ThemeRow | null, base?: Colours | null, name?: string) => {
    setProblem(null)
    setDraft({ id: row?.id ?? null, name: row?.name ?? name ?? t('themes.newName'), colours: full(row?.colours ?? base ?? me?.theme_colours), shared: row?.shared ?? false })
  }
  const setColour = (token: Token, value: string) =>
    setDraft((current) => (current ? { ...current, colours: { ...current.colours, [mode]: { ...current.colours[mode], [token]: value } } } : current))
  const save = async () => {
    if (!draft) return
    setBusy(true)
    setProblem(null)
    try {
      const row = draft.id === null
        ? await themesApi.create(draft.name, draft.colours, draft.shared)
        : await themesApi.change(draft.id, { name: draft.name, colours: draft.colours, shared: draft.shared })
      setDraft(null)
      await load()
      await setAppearance({ theme: row.ref })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (row: ThemeRow) => {
    try {
      if (chosen === row.ref) await setAppearance({ theme: 'nexlore' })
      await themesApi.remove(row.id)
      await load()
    } catch (error) {
      fail(error)
    }
  }
  const download = (name: string, colours: Colours) => {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([themeFile(name, colours)], { type: 'application/json' }))
    link.download = `${name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'theme'}.nexlore-theme.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }
  const takeIn = async (picked: File | undefined) => {
    if (!picked) return
    const read = readThemeFile(await picked.text())
    if (!read) return setProblem(t('themes.notAFile'))
    edit(null, read.colours, read.name || t('themes.newName'))
  }

  const card = (ref: string, name: string, colours: Colours | null, extra?: React.ReactNode, note?: string) => (
    <div key={ref} className={'overflow-hidden rounded-xl border bg-ink-850 ' + (chosen === ref ? 'border-accent-500 ring-1 ring-accent-500' : 'border-ink-700')}>
      <button type="button" onClick={() => void choose(ref)} aria-pressed={chosen === ref} className="block w-full text-left" data-theme-ref={ref}>
        <Swatch colours={colours} />
        <span className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-mist-200">
          <span className="truncate">{name}</span>
          {note && <span className="shrink-0 text-xs text-mist-500">{note}</span>}
        </span>
      </button>
      {extra && <div className="flex flex-wrap gap-1 border-t border-ink-700 px-2 py-1.5">{extra}</div>}
    </div>
  )
  const small = 'rounded-full px-2 py-0.5 text-xs text-mist-400 hover:bg-ink-800 hover:text-mist-100'
  const weak = draft ? weakSpots(draft.colours) : []

  return (
    <section className="space-y-4 rounded-2xl border border-ink-700 bg-ink-850/60 p-5" data-testid="themes">
      <div className="flex flex-wrap items-start gap-3">
        <span className="rounded-lg bg-accent-500/10 p-2 text-accent-400"><Symbol name="star" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-mist-100">{t('themes.title')}</h2>
          <p className="text-sm text-mist-400">{t('themes.text')}</p>
        </div>
        <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void takeIn(event.target.files?.[0])} aria-label={t('themes.import')} />
        <button type="button" onClick={() => file.current?.click()} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-800">{t('themes.import')}</button>
        <button type="button" onClick={() => edit(null)} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent hover:bg-accent-400">{t('themes.new')}</button>
      </div>

      {draft ? (
        <div className="space-y-3 rounded-xl border border-ink-700 bg-ink-900 p-4" data-testid="theme-editor">
          <div className="flex flex-wrap items-center gap-2">
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-label={t('themes.name')} maxLength={40} className="h-8 w-48 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-sm" />
            <div className="inline-flex rounded-full border border-ink-700 bg-ink-850 p-0.5" role="radiogroup" aria-label={t('themes.side')}>
              {(['dark', 'light'] as const).map((side) => (
                <button key={side} type="button" role="radio" aria-checked={mode === side} onClick={() => setMode(side)} className={'rounded-full px-3 py-0.5 text-sm ' + (mode === side ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400')}>
                  {t(`looks2.modes.${side}`)}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-mist-300">
              <input type="checkbox" checked={draft.shared} onChange={(event) => setDraft({ ...draft, shared: event.target.checked })} className="accent-accent-500" />
              {t('themes.share')}
            </label>
          </div>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {TOKEN_GROUPS.map(([group, tokens]) => (
              <div key={group}>
                <div className="mb-1 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t(`themes.groups.${group}`)}</div>
                {tokens.map((token) => (
                  <label key={token} className="flex items-center gap-2 py-0.5 text-sm text-mist-300">
                    <input type="color" value={draft.colours[mode][token]} onChange={(event) => setColour(token, event.target.value)} aria-label={`${t(`themes.tokens.${token}`)} (${t(`looks2.modes.${mode}`)})`} className="h-6 w-8 cursor-pointer rounded border border-ink-600 bg-transparent p-0" />
                    <span className="flex-1">{t(`themes.tokens.${token}`)}</span>
                    <code className="text-[11px] text-mist-600">{draft.colours[mode][token]}</code>
                  </label>
                ))}
              </div>
            ))}
          </div>
          {weak.length > 0 && (
            <ul className="space-y-0.5 text-xs text-warn-500" data-testid="theme-weak">
              {weak.map((spot) => (
                <li key={spot.mode + spot.token}>{t('themes.weak', { token: t(`themes.tokens.${spot.token}`), mode: t(`looks2.modes.${spot.mode}`), ratio: spot.ratio.toLocaleString() })}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-mist-500">{t('themes.derived')}</p>
          <CalloutsEditor callouts={draft.colours.callouts ?? {}} mode={mode} onChange={(callouts) => setDraft({ ...draft, colours: { ...draft.colours, callouts } })} />
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => download(draft.name, draft.colours)} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-800">{t('themes.export')}</button>
            <button type="button" onClick={() => { setDraft(null); restore() }} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-800">{t('common.cancel')}</button>
            <button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save()} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40">{t('common.save')}</button>
          </div>
        </div>
      ) : (
        list && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {card('nexlore', 'nexlore', null, undefined, t('themes.standard'))}
              {list.built_in.map((theme) => card(theme.ref, t(`themes.builtIn.${theme.ref}`), theme.colours, <button type="button" className={small} onClick={() => edit(null, theme.colours, t(`themes.builtIn.${theme.ref}`))}>{t('themes.copy')}</button>))}
            </div>
            {list.shared.length > 0 && (
              <>
                <h3 className="pt-2 text-sm font-semibold text-mist-200">{t('themes.shared')}</h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {list.shared.map((theme) => card(theme.ref, theme.name, theme.colours, <button type="button" className={small} onClick={() => edit(null, theme.colours, theme.name)}>{t('themes.copy')}</button>, theme.owner))}
                </div>
              </>
            )}
            <h3 className="pt-2 text-sm font-semibold text-mist-200">{t('themes.mine')}</h3>
            {list.mine.length === 0 ? (
              <p className="text-sm text-mist-500">{t('themes.noneMine')}</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {list.mine.map((theme) =>
                  card(
                    theme.ref,
                    theme.name,
                    theme.colours,
                    <>
                      <button type="button" className={small} onClick={() => edit(theme)}>{t('themes.edit')}</button>
                      <button type="button" className={small} onClick={() => download(theme.name, theme.colours)}>{t('themes.export')}</button>
                      <button type="button" className={small} onClick={() => void remove(theme)}>{t('themes.remove')}</button>
                    </>,
                    theme.shared ? t('themes.sharedNote') : undefined,
                  ),
                )}
              </div>
            )}
          </>
        )
      )}
      {problem && <p role="alert" className="text-sm text-bad-500">{problem}</p>}
    </section>
  )
}
