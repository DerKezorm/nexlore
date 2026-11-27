/**
 * About nexlore (block X2, after nexmail; plan "Einstellungen": the kit's \`AboutPage\`): version, licence, where it
 * comes from, and whether a newer one is out. Installing nexlore as an app moved to Connections (E6, E28).
 *
 * The update check is the shared module updates (\`vendor/nexupdates\`, U1 to U21): the card "Aktualisierungen" with
 * the daily check, "Jetzt nachsehen" and what goes out is the operator's alone; a member sees only the own version
 * (U2, U15), and its page never asks for the state.
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { tabId } from '../api/client'
import { LOGO, whatsNewFetch } from '../lib/wasneuModule'
import { useAuth } from '../state/auth'
import { AboutPage, formatMoment, Notice } from '../vendor/nexui'
import { useUpdates, useUpdatesTexts, whatGoesOut, type Fetcher } from '../vendor/nexupdates'
import { useAboutWhatsNew } from '../vendor/nexwasneu'

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

/** The module's calls with what every call of nexlore carries: the tab's name (\`X-Nexlore-Client\`). */
const fetcher: Fetcher = (path, init) =>
  fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.headers as Record<string, string>), 'X-Nexlore-Client': tabId() } })

export function AboutArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const operator = me?.role === 'operator'
  // The one form of every nex app (E65, ui 1.1.2).
  const when = useCallback((iso: string) => formatMoment(iso, i18n.language), [i18n.language])
  const state = useUpdates({ fetcher, operator, when, language: i18n.language })
  const words = useUpdatesTexts(i18n.language)
  // "What's new" of the running version and "Earlier versions" (the shared module wasneu); reading here marks nothing.
  const news = useAboutWhatsNew({ app: 'nexlore', logo: LOGO, fetcher: whatsNewFetch, language: i18n.language })
  const { about, problem } = state

  if (!about) return problem ? <Notice tone="danger">{problem}</Notice> : null
  return (
    <>
      <AboutPage
        app="nexlore"
        logo={LOGO}
        tagline={t('about.subtitle')}
        version={about.version}
        licence={{ name: about.license, href: 'https://www.gnu.org/licenses/agpl-3.0.html' }}
        source={about.repo_url}
        releases={about.releases_url}
        project={about.project_url}
        report={`${about.repo_url}/issues/new`}
        {...news.about}
        updates={state.updates}
        showUpdates={state.showUpdates}
        operator={operator}
        onDaily={state.onDaily}
        onCheck={state.onCheck}
        checking={state.checking}
        builtWith={PARTS}
        builtWithMore={
          <p className="m-0 text-sm text-[var(--nexui-text-muted)]">
            {t('about.fonts')}: {FONTS.join(', ')} (OFL-1.1). {t('about.fontsText')}
          </p>
        }
        problem={problem}
        texts={{ updatesWhatGoesOut: whatGoesOut(words, 'nexlore') }}
      />
      {news.window}
    </>
  )
}
