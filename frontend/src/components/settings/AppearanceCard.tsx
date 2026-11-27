/**
 * Settings › Appearance › "Schriften und Breite": the fonts, the text size and width, for the own account (on every
 * device). Light or dark is the account module's card "Aussehen" above it. Each
 * change is saved and shown at once; the sample below shows the note text as it will look.
 */
import { Type } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FONT_CHOICES, FONTS, WIDTHS, type Appearance, type Width } from '../../lib/appearance'
import { errorText } from '../../lib/errors'
import { useAuth } from '../../state/auth'
import { ApiError } from '../../api/client'
import { Card, CheckboxRow, Segment } from '../../vendor/nexui'

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
    <Card id="fonts" icon={Type} title={t('looks2.title')} subtitle={t('looks2.text')} testId="appearance">

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

      <Segment
        label={t('looks2.width')}
        value={look.width}
        options={(Object.keys(WIDTHS) as Width[]).map((width) => ({ value: width, label: t(`looks2.widths.${width}`) }))}
        onChange={(width) => void change({ width })}
        hints={[t('looks2.wideHint')]}
        testId="appearance-width"
      />

      <CheckboxRow label={t('looks2.spaceThemes')} hint={t('looks2.spaceThemesHint')} checked={look.space_themes} onChange={(on) => void change({ space_themes: on })} />
      <CheckboxRow label={t('looks2.graphGlow')} hint={t('looks2.graphGlowHint')} checked={look.graph_glow !== false} onChange={(on) => void change({ graph_glow: on })} />

      <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
        <div className="nn-prose mx-auto" style={{ maxWidth: 'var(--nn-width)' }} data-testid="appearance-sample">
          <h3>{t('looks2.sampleTitle')}</h3>
          <p>{t('looks2.sampleText')}</p>
          <p><code>const answer = 42</code></p>
        </div>
      </div>
      {problem && <p role="alert" className="text-sm text-bad-500">{problem}</p>}
    </Card>
  )
}
