/**
 * "What's new" (block X3): a banner under the header after an update, for every account, and the window with the
 * written text of the version. Each account puts it away for itself (`POST /api/me/whats-new/seen`); the server keeps
 * which version it read, so it does not come back on another device.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { authApi } from '../api/client'
import { useWhatsNew, type WhatsNewEntry } from '../lib/whatsNew'
import { useAuth } from '../state/auth'
import { Symbol } from './Symbol'

export function WhatsNewWindow({ version, entry, onClose }: { version: string; entry: WhatsNewEntry; onClose: () => void }) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose()
      }}
      className="m-auto max-h-[min(44rem,calc(100dvh-2rem))] w-[min(40rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <div className="flex max-h-[inherit] flex-col">
        <div className="flex items-start gap-3 border-b border-ink-700 px-5 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/12 text-accent-400">
            <Symbol name="sparkle" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-mist-100">
              {t('whatsNew.title', { version })}
            </h2>
            <p className="mt-1 text-sm text-mist-400">{entry.lead}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-lg p-1 text-mist-400 hover:bg-ink-850 hover:text-mist-100">
            <Symbol name="close" className="h-4 w-4" />
          </button>
        </div>
        <div className="nn-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {entry.sections.map((part) => (
            <section key={part.title}>
              <h3 className="font-semibold text-mist-100">{part.title}</h3>
              <p className="mt-0.5 flex items-start gap-1.5 text-xs text-accent-400">
                <Symbol name="open" className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  <span className="sr-only">{t('whatsNew.where')} </span>
                  {part.where}
                </span>
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-mist-300">{part.body}</p>
            </section>
          ))}
          {entry.small.length > 0 && (
            <section>
              <h3 className="text-xs font-medium tracking-wide text-mist-400 uppercase">{entry.smallTitle}</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-mist-300">
                {entry.small.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div className="flex justify-end border-t border-ink-700 px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400">
            {t('whatsNew.done')}
          </button>
        </div>
      </div>
    </dialog>
  )
}

/** Under the header, as long as the running version has a text the account has not read or put away. */
export function WhatsNewBanner() {
  const { t, i18n } = useTranslation()
  const { me, refresh } = useAuth()
  const unread = !!me && me.whats_new_seen !== me.version
  const { entry } = useWhatsNew(me?.version, i18n.language, unread)
  const [open, setOpen] = useState(false)
  const [gone, setGone] = useState(false)
  if (!me || !unread || !entry || gone) return null

  function putAway() {
    setGone(true)
    void authApi.whatsNewSeen().then(() => refresh(), () => undefined)
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-accent-500/30 bg-accent-500/10 px-4 py-2 text-sm" role="status" data-testid="whats-new-banner">
        <Symbol name="sparkle" className="h-4 w-4 shrink-0 text-accent-400" />
        <span className="min-w-0 flex-1">{t('whatsNew.banner', { version: me.version })}</span>
        <button type="button" onClick={() => setOpen(true)} className="rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-on-accent hover:bg-accent-400">
          {t('whatsNew.show')}
        </button>
        <button type="button" onClick={putAway} aria-label={t('whatsNew.putAway')} title={t('whatsNew.putAway')} className="rounded p-0.5 text-mist-400 hover:text-mist-100">
          <Symbol name="close" className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <WhatsNewWindow
          version={me.version}
          entry={entry}
          onClose={() => {
            setOpen(false)
            putAway()
          }}
        />
      )}
    </>
  )
}
