/** The language of the own account (Profile), and for the operator the template for one more language. */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { downloadTemplate, languageOptions, type LanguageOption } from '../../i18n'
import { useAuth } from '../../state/auth'
import { Symbol, type SymbolName } from '../Symbol'

export function LanguageCard() {
  const { t, i18n } = useTranslation()
  const { setLanguage, me } = useAuth()
  const operator = me?.role === 'operator'
  const [options, setOptions] = useState<LanguageOption[]>([])

  useEffect(() => {
    let alive = true
    void languageOptions().then((list) => alive && setOptions(list))
    return () => {
      alive = false
    }
  }, [])

  return (
    <Card symbol="globe" title={t('settings.language.title')} text={operator ? t('settings.language.text') : t('settings.language.textMember')}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
        <label htmlFor="language" className="font-medium">
          {t('settings.language.choose')}
        </label>
        <select
          id="language"
          value={i18n.language}
          onChange={(e) => void setLanguage(e.target.value)}
          className="rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-mist-100"
        >
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
              {option.added ? ` (${t('settings.language.added')})` : ''}
            </option>
          ))}
        </select>
        {operator && (
        <button
          type="button"
          onClick={downloadTemplate}
          className="ml-auto inline-flex items-center gap-2 rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-800"
          title={t('settings.language.templateHint')}
        >
          <Symbol name="download" /> {t('settings.language.template')}
        </button>
        )}
      </div>
      {operator && <p className="mt-2 text-xs text-mist-500">{t('settings.language.templateHint')}</p>}
    </Card>
  )
}

function Card({ symbol, title, text, children }: { symbol: SymbolName; title: string; text: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5">
      <div className="mb-4 flex gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/12 text-accent-400">
          <Symbol name={symbol} />
        </span>
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-sm text-mist-500">{text}</p>
        </div>
      </div>
      {children}
    </section>
  )
}
