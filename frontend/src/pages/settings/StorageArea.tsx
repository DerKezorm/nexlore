/**
 * Server › Storage and backups: the cards "Speicher" and "Sicherung" of the shared module sicherung
 * (`vendor/nexsicherung`, bauplaene/sicherung 1.0.1) over its routes (`/api/server/storage`). nexlore hands it its
 * sentence of what a backup holds, the counts of an entry, what a restore changes in the vault and the names of its own
 * parts (the vault, the trash). After a restore the page waits for nexlore to be back and goes to the sign-in, as
 * before the module: the restore ends every session.
 */
import { useTranslation } from 'react-i18next'

import { tabId } from '../../api/client'
import { useAuth } from '../../state/auth'
import { StorageArea as SharedStorageArea } from '../../vendor/nexsicherung/StorageArea'
import { makeSicherungApi, type Brief, type Entry } from '../../vendor/nexsicherung/sicherung'
import { languageOf } from '../../vendor/nexui'

/** nexlore's own client for the module: every request names its tab (changes are refused without it). */
const api = makeSicherungApi((path, init) => {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-Nexlore-Client', tabId())
  return fetch(path, { ...init, headers })
}, '/api/server/storage')

const number = (value: unknown) => (typeof value === 'number' ? value : 0)

/** Restoring restarts the server and ends every session: wait until it was away and is back, then the sign-in. */
function waitForTheRestart() {
  let away = false
  const started = Date.now()
  const timer = window.setInterval(() => {
    void fetch('/api/setup', { cache: 'no-store' }).then(
      (answer) => {
        if (answer.ok && (away || Date.now() - started > 90_000)) {
          window.clearInterval(timer)
          window.location.assign('/login')
        }
        if (!answer.ok) away = true
      },
      () => {
        away = true
      },
    )
  }, 1500)
}

export function StorageArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const facts = (entry: Entry) =>
    entry.facts && 'notes' in entry.facts ? t('storage.counts', { notes: t('storage.notes', { count: number(entry.facts.notes) }), files: t('storage.files', { count: number(entry.facts.files) }) }) : null
  const details = (brief: Brief) => {
    const found = brief.details ?? {}
    return (
      <p className="m-0" data-testid="restore-changes">
        {t('storage.would', { add: number(found.would_add), change: number(found.would_change), remove: number(found.would_remove) })}
      </p>
    )
  }
  const partLabel = (key: string) => (key === 'trash' ? t('storage.trash') : undefined)
  return (
    <SharedStorageArea
      app="nexlore"
      things={t('settings.things')}
      holds={t('storage.holds')}
      api={api}
      password={me?.sign_in === 'password'}
      facts={facts}
      details={details}
      partLabel={partLabel}
      onRestarting={waitForTheRestart}
      language={languageOf(i18n.language)}
    />
  )
}
