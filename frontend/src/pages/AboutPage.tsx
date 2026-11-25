/**
 * About nexlore (block X2, after nexmail; plan "Einstellungen": the kit's \`AboutPage\`): version, licence, where it
 * comes from, and whether a newer one is out. Installing nexlore as an app moved to Connections (E6, E28).
 *
 * The switch for the daily check stands here, where its answer shows, and the page says what goes out: the question
 * to GitHub is the one call nexlore makes by itself. Every account sees the answer; switching and asking now belong to
 * the operator, because the question goes out for the whole installation.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { aboutApi, ApiError, type About, type Updates } from '../api/client'
import { errorText } from '../lib/errors'
import { useWhatsNew } from '../lib/whatsNew'
import { useAuth } from '../state/auth'
import { AboutPage, Notice } from '../vendor/nexui'

const PARTS = [
  { name: 'FastAPI', url: 'https://fastapi.tiangolo.com', licence: 'MIT' },
  { name: 'SQLAlchemy', url: 'https://www.sqlalchemy.org', licence: 'MIT' },
  { name: 'SQLite', url: 'https://sqlite.org', licence: 'Public Domain' },
  { name: 'Pillow', url: 'https://python-pillow.org', licence: 'MIT-CMU' },
  { name: 'pypdf', url: 'https://github.com/py-pdf/pypdf', licence: 'BSD-3' },
  { name: 'NumPy', url: 'https://numpy.org', licence: 'BSD-3' },
  { name: 'React', url: 'https://react.dev', licence: 'MIT' },
  { name: 'Vite', url: 'https://vite.dev', licence: 'MIT' },
  { name: 'Tailwind CSS', url: 'https://tailwindcss.com', licence: 'MIT' },
  { name: 'Milkdown', url: 'https://milkdown.dev', licence: 'MIT' },
  { name: 'ProseMirror', url: 'https://prosemirror.net', licence: 'MIT' },
  { name: 'CodeMirror', url: 'https://codemirror.net', licence: 'MIT' },
  { name: 'marked', url: 'https://marked.js.org', licence: 'MIT' },
  { name: 'KaTeX', url: 'https://katex.org', licence: 'MIT' },
  { name: 'Mermaid', url: 'https://mermaid.js.org', licence: 'MIT' },
  { name: 'd3-force', url: 'https://d3js.org/d3-force', licence: 'ISC' },
  { name: 'Lucide', url: 'https://lucide.dev', licence: 'ISC' },
  { name: 'i18next', url: 'https://www.i18next.com', licence: 'MIT' },
]

const FONTS = ['Inter', 'Atkinson Hyperlegible', 'Literata', 'Source Serif', 'IBM Plex Sans', 'JetBrains Mono']

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

export function AboutArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const operator = me?.role === 'operator'
  const [about, setAbout] = useState<About | null>(null)
  const [updates, setUpdates] = useState<Updates | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The written text of the running version, to read again at any time.
  const { entry } = useWhatsNew(me?.version, i18n.language)

  const load = useCallback(() => {
    void aboutApi.about().then(setAbout, (error: unknown) => setProblem(errorText(code(error))))
    // The answer is a side matter: when it does not come, the page simply shows none.
    void aboutApi.updates().then(setUpdates, () => setUpdates(null))
  }, [])
  useEffect(load, [load])

  async function checkNow() {
    setBusy(true)
    try {
      setUpdates(await aboutApi.check())
      setProblem(null)
    } catch (error) {
      setProblem(errorText(code(error)))
    } finally {
      setBusy(false)
    }
  }

  async function switchCheck(on: boolean) {
    if (updates) setUpdates({ ...updates, update_check: on })
    try {
      setUpdates(await aboutApi.setCheck(on))
    } catch (error) {
      setProblem(errorText(code(error)))
      load()
    }
  }

  if (!about) return problem ? <Notice tone="danger">{problem}</Notice> : null
  return (
    <AboutPage
      app="nexlore"
      logo="/logo.svg?v=2"
      tagline={t('about.subtitle')}
      version={about.version}
      licence={{ name: about.license, href: 'https://www.gnu.org/licenses/agpl-3.0.html' }}
      source={about.repo_url}
      releases={about.releases_url}
      project={about.project_url}
      report={`${about.repo_url}/issues/new`}
      whatsNew={entry ?? null}
      updates={
        updates
          ? {
              checkDaily: updates.update_check,
              checked: updates.checked,
              latest: updates.latest ?? null,
              newer: updates.newer,
              checkedAt: updates.checked_at ? new Date(updates.checked_at).toLocaleString(i18n.language) : null,
              releaseUrl: updates.release_url ?? null,
            }
          : null
      }
      operator={operator}
      onDaily={(on) => void switchCheck(on)}
      onCheck={() => void checkNow()}
      checking={busy}
      builtWith={PARTS}
      builtWithMore={
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]">
          {t('about.fonts')}: {FONTS.join(', ')} (OFL-1.1). {t('about.fontsText')}
        </p>
      }
      problem={problem}
      texts={{ updatesWhatGoesOut: t('about.updates.whatGoesOut') }}
    />
  )
}
