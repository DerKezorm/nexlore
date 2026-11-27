/**
 * What waits for the account besides "New": drafts an AI program wrote (M7) and proposals for notes, the waiting ones
 * of others and the own ones with their answer. They stood in the account menu before; there is no such menu any more,
 * so they stand in the sidebar, below "New", only while there is something. Asked at once, every minute and when a
 * request of an AI program changes.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { draftsApi, proposalsApi, type DraftInfo, type Proposal } from '../api/client'
import { REQUESTS_EVENT } from '../lib/mcpRequests'
import { usePeople } from '../lib/people'
import { noteUrl } from '../lib/vault'
import { useAuth } from '../state/auth'
import { DraftCompare } from './DraftCompare'
import { Symbol } from './Symbol'

const ROW = 'flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-ink-850'

export function OpenDrafts() {
  const { t } = useTranslation()
  const person = usePeople()
  const navigate = useNavigate()
  const { me } = useAuth()
  const [drafts, setDrafts] = useState<DraftInfo[]>([])
  const [proposals, setProposals] = useState<{ waiting: Proposal[]; mine: Proposal[] }>({ waiting: [], mine: [] })
  const [draftShown, setDraftShown] = useState<number | null>(null)
  const signedIn = !!me

  useEffect(() => {
    if (!signedIn) return
    let live = true
    const ask = () => {
      void draftsApi.list().then((found) => live && setDrafts(found), () => undefined)
      void proposalsApi.overview().then((found) => live && setProposals(found), () => undefined)
    }
    ask()
    const timer = window.setInterval(ask, 60_000)
    window.addEventListener(REQUESTS_EVENT, ask)
    return () => {
      live = false
      window.clearInterval(timer)
      window.removeEventListener(REQUESTS_EVENT, ask)
    }
  }, [signedIn])

  if (!me) return null
  const shown = [...proposals.waiting, ...proposals.mine.slice(0, 5)].slice(0, 8)
  if (drafts.length === 0 && shown.length === 0) return null

  return (
    <div className="border-b border-ink-700/60 px-2 pt-3 pb-2" data-testid="sidebar-drafts">
      {drafts.length > 0 && (
        <>
          <p className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-accent-400 uppercase">
            {t('drafts.open')} · <span data-testid="drafts-count">{drafts.length}</span>
          </p>
          {drafts.slice(0, 8).map((draft) => (
            <button
              key={draft.id}
              type="button"
              onClick={() => (draft.new ? setDraftShown(draft.id) : navigate(noteUrl(draft.path)))}
              className={ROW}
            >
              <Symbol name="sparkle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-400" />
              <span className="min-w-0">
                <span className="block truncate text-mist-200">{draft.new ? t('drafts.newNote', { title: draft.title }) : draft.title}</span>
                <span className="block truncate text-xs text-mist-500">{draft.key_name}</span>
              </span>
            </button>
          ))}
        </>
      )}
      {shown.length > 0 && (
        <div data-testid="menu-proposals" className={drafts.length > 0 ? 'mt-2' : ''}>
          <p className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-accent-400 uppercase">
            {t('proposals.menu')}
            {proposals.waiting.length > 0 && <> · {t('proposals.menuWaiting', { count: proposals.waiting.length })}</>}
          </p>
          {shown.map((proposal) => (
            <button key={proposal.id} type="button" onClick={() => navigate(noteUrl(proposal.path))} className={ROW}>
              <Symbol name="pencil" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-400" />
              <span className="min-w-0">
                <span className="block truncate text-mist-200">{proposal.title}</span>
                <span className="block truncate text-xs text-mist-500">
                  {proposal.by !== me.name
                    ? person(proposal.by)
                    : proposal.status === 'taken'
                      ? t('proposals.mineTaken', { name: person(proposal.decided_by) })
                      : proposal.status === 'copied'
                        ? t('proposals.mineCopied', { name: person(proposal.decided_by) })
                        : proposal.status === 'declined'
                          ? t('proposals.mineDeclined', { name: person(proposal.decided_by) })
                          : t('proposals.mineOpen')}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {draftShown !== null && (
        <DraftCompare
          draftId={draftShown}
          onClose={() => setDraftShown(null)}
          onDone={(result) => {
            setDraftShown(null)
            void draftsApi.list().then(setDrafts, () => undefined)
            if (result.path) navigate(noteUrl(result.path))
          }}
        />
      )}
    </div>
  )
}
