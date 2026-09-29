/**
 * Settings → Look: light or dark, the fonts, the text size and width, for the own account (on every device). Each
 * change is saved and shown at once; the sample below shows the note text as it will look.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FONT_CHOICES, FONTS, WIDTHS, type Appearance, type Mode, type Width } from '../../lib/appearance'
import { errorText } from '../../lib/errors'
import { useAuth } from '../../state/auth'
import { ApiError } from '../../api/client'
import { Symbol } from '../Symbol'

const segment = (on: boolean) =>
  'rounded-full px-3 py-1 text-sm ' + (on ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400 hover:text-mist-100')

export function AppearanceCard() {
  const { t } = useTranslation()
  const { me, setAppearance } = useAuth()
  const [problem, setProblem] = useState<string | null>(null)
  const look = me?.appearance
  // Every font on offer loads here, so each choice shows in its own letters.
  useEffect(() => {
    for (const font of Object.values(FONTS)) void font.load?.()
  }, [])
  if (!look) return null

  const change = async (changes: Partial<Appearance>) => {
    setProblem(null)
    try {
      await setAppearance(changes)
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }
  const fontRow = (kind: 'ui' | 'text' | 'code', key: 'font_ui' | 'font_text' | 'font_code') => (
    <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-start">
      <span className="pt-2 text-sm text-mist-300">{t(`looks2.font.${kind}`)}</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t(`looks2.font.${kind}`)}>
        {FONT_CHOICES[kind].map((name) => {
          const on = look[key] === name
          const family = kind === 'code' && name === 'system' ? 'ui-monospace, Consolas, monospace' : FONTS[name].family
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => void change({ [key]: name } as Partial<Appearance>)}
              className={'rounded-xl border px-3 py-2 text-left ' + (on ? 'border-accent-500 bg-accent-500/10' : 'border-ink-700 bg-ink-850 hover:border-ink-600')}
            >
              <span className="block text-xl text-mist-100" style={{ fontFamily: family }}>Ag</span>
              <span className="block truncate text-xs text-mist-400">{name === 'system' ? t('looks2.font.system') : FONTS[name].label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <section className="space-y-5 rounded-2xl border border-ink-700 bg-ink-850/60 p-5" data-testid="appearance">
      <div className="flex items-start gap-3">
        <span className="rounded-lg bg-accent-500/10 p-2 text-accent-400"><Symbol name="eye" /></span>
        <div>
          <h2 className="font-semibold text-mist-100">{t('looks2.title')}</h2>
          <p className="text-sm text-mist-400">{t('looks2.text')}</p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center">
        <span className="text-sm text-mist-300">{t('looks2.mode')}</span>
        <div className="inline-flex w-fit rounded-full border border-ink-700 bg-ink-850 p-0.5" role="radiogroup" aria-label={t('looks2.mode')}>
          {(['light', 'dark', 'system'] as Mode[]).map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={look.mode === mode} onClick={() => void change({ mode })} className={segment(look.mode === mode)}>
              {t(`looks2.modes.${mode}`)}
            </button>
          ))}
        </div>
      </div>

      {fontRow('ui', 'font_ui')}
      {fontRow('text', 'font_text')}
      {fontRow('code', 'font_code')}

      <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center">
        <label htmlFor="looks-size" className="text-sm text-mist-300">{t('looks2.size')}</label>
        <div className="flex items-center gap-3">
          <input id="looks-size" type="range" min={14} max={20} step={1} value={look.size} onChange={(event) => void change({ size: Number(event.target.value) })} className="w-48 accent-accent-500" />
          <span className="text-sm text-mist-400 tabular-nums">{look.size} px</span>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center">
        <span className="text-sm text-mist-300">{t('looks2.width')}</span>
        <div className="inline-flex w-fit flex-wrap rounded-full border border-ink-700 bg-ink-850 p-0.5" role="radiogroup" aria-label={t('looks2.width')}>
          {(Object.keys(WIDTHS) as Width[]).map((width) => (
            <button key={width} type="button" role="radio" aria-checked={look.width === width} onClick={() => void change({ width })} className={segment(look.width === width)}>
              {t(`looks2.widths.${width}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-mist-500">{t('looks2.wideHint')}</p>

      <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
        <div className="nn-prose mx-auto" style={{ maxWidth: 'var(--nn-width)' }} data-testid="appearance-sample">
          <h3>{t('looks2.sampleTitle')}</h3>
          <p>{t('looks2.sampleText')}</p>
          <p><code>const answer = 42</code></p>
        </div>
      </div>
      {problem && <p role="alert" className="text-sm text-bad-500">{problem}</p>}
    </section>
  )
}
