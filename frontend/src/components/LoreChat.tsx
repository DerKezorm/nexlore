/**
 * A conversation with Lore (`lib/lore.ts`) as a chat with bubbles, in the overlay in the corner and on the page "Ask
 * Lore" (design answer 05.10.2026, after the attrappe `tools/lore-attrappe/attrappe-overlay.html`): the own questions
 * on the right, Lore's answers on the left beside the spider, as they come. In an answer only small raised numbers;
 * below it, folded, the sources and the way Lore searched; what the notes do not say as a quiet line at the foot of
 * the bubble. Copy, save as a note and propose show on hovering the answer.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ApiError, loreApi, type LoreAsk, type LoreSource, type LoreTrace } from '../api/client'
import { errorText } from '../lib/errors'
import { answerHtml, answerParts, askLore, PROPOSALS_EVENT, sourceUrl } from '../lib/lore'
import { noteUrl } from '../lib/vault'
import { copyText } from '../lib/vaultActions'
import { LoreSpider } from './LoreSpider'
import { Symbol } from './Symbol'

export type Turn = {
  /** The message on the server, once it is kept. */
  id?: number
  role: 'user' | 'assistant'
  text: string
  sources: LoreSource[]
  trace: LoreTrace | null
  error: string
  /** Still being written. */
  pending?: boolean
}

type Props = {
  /** The conversation shown; null: a new one, which gets its number with the first answer. */
  conversation: number | null
  onConversation: (id: number) => void
  /** The note asked about (open in the page): it goes along whole, and an answer can become a proposal for it. */
  note?: string
  /** The spaces to look in; undefined: every readable one. */
  spaces?: number[]
  /** In the overlay: narrower bubbles, smaller type. */
  compact?: boolean
  /** While there is nothing yet: the greeting with its suggestions. */
  empty?: (ask: (question: string) => void) => ReactNode
  placeholder: string
  /** Told when an answer is done, so that a list or a dot can show it. */
  onAnswered?: () => void
  /** Under the field (the page: what Lore sees). */
  footer?: ReactNode
}

export function LoreChat({ conversation, onConversation, note, spaces, compact = false, empty, placeholder, onAnswered, footer }: Props) {
  const { t } = useTranslation()
  const [turns, setTurns] = useState<Turn[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // A conversation this view just started: when its number comes back as the one shown, it must not be loaded again
  // over the answer being written. Only that once; any other change of the conversation loads it.
  const started = useRef<number | null>(null)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setProblem(null)
    if (conversation !== null && conversation === started.current) {
      started.current = null
      return
    }
    started.current = null
    if (conversation === null) {
      // A new conversation: whatever was shown goes.
      setTurns([])
      return
    }
    let current = true
    setLoading(true)
    loreApi.get(conversation).then(
      (found) => {
        if (!current) return
        setTurns(found.messages.map((message) => ({ id: message.id, role: message.role, text: message.text, sources: message.sources, trace: message.trace, error: message.error })))
        setLoading(false)
      },
      (error) => {
        if (!current) return
        setProblem(error instanceof ApiError ? error.code : 'internal_error')
        setLoading(false)
      },
    )
    return () => {
      current = false
    }
  }, [conversation])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  const change = (update: (last: Turn) => Turn) =>
    setTurns((all) => (all.length ? [...all.slice(0, -1), update(all[all.length - 1])] : all))

  const ask = useCallback(
    async (question: string) => {
      const asked = question.trim()
      if (!asked || busy) return
      setBusy(true)
      setProblem(null)
      setDraft('')
      setTurns((all) => [
        ...all,
        { role: 'user', text: asked, sources: [], trace: null, error: '' },
        { role: 'assistant', text: '', sources: [], trace: null, error: '', pending: true },
      ])
      const body: LoreAsk = { question: asked }
      if (conversation !== null) body.conversation = conversation
      if (spaces) body.spaces = spaces
      if (note) body.note = note
      try {
        await askLore(body, (event) => {
          if (event.name === 'start') {
            change((last) => ({ ...last, sources: event.data.sources, trace: event.data.trace }))
            if (conversation === null) {
              started.current = event.data.conversation
              onConversation(event.data.conversation)
            }
          } else if (event.name === 'delta') change((last) => ({ ...last, text: last.text + event.data.t }))
          else if (event.name === 'sources') change((last) => ({ ...last, sources: event.data.sources, trace: event.data.trace }))
          else if (event.name === 'error') change((last) => ({ ...last, error: event.data.code, pending: false }))
          else if (event.name === 'done') change((last) => ({ ...last, id: event.data.message, pending: false }))
        })
        change((last) => ({ ...last, pending: false }))
        onAnswered?.()
      } catch (error) {
        // Refused before it started: the question was not kept, so it goes back into the field.
        setTurns((all) => all.slice(0, -2))
        setDraft(asked)
        setProblem(error instanceof ApiError ? error.code : 'internal_error')
      } finally {
        setBusy(false)
      }
    },
    [busy, conversation, spaces, note, onConversation, onAnswered],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={'nn-scroll min-h-0 flex-1 overflow-y-auto ' + (compact ? 'px-3.5 py-3' : 'px-3 py-5 sm:px-6')}>
        <div className={'flex min-h-full flex-col gap-3.5 ' + (compact ? '' : 'mx-auto max-w-3xl')} data-testid="lore-turns">
          {!turns.length && !loading && empty?.((question) => void ask(question))}
          {loading && <p className="text-sm text-mist-500">{t('common.loading')}</p>}
          {turns.map((turn, index) =>
            turn.role === 'user' ? (
              <p
                key={index}
                className={'ml-auto w-fit max-w-[82%] rounded-[18px] rounded-br-[5px] bg-accent-500 px-3.5 py-2 whitespace-pre-wrap text-on-accent ' + (compact ? 'text-sm' : '')}
                data-testid="lore-question"
              >
                {turn.text}
              </p>
            ) : (
              <Answer key={index} turn={turn} compact={compact} conversation={conversation} note={note} />
            ),
          )}
          <div ref={end} />
        </div>
      </div>
      {problem && (
        <p role="alert" className={'mx-3 mb-2 rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500 ' + (compact ? '' : 'sm:mx-auto sm:w-full sm:max-w-3xl')}>
          {errorText(problem)}
        </p>
      )}
      <div className={'border-t border-ink-700 ' + (compact ? 'px-3 pt-2.5 pb-3' : 'px-3 pt-3 pb-4 sm:px-6')}>
        <div className={compact ? '' : 'mx-auto max-w-3xl'}>
          <form
            className="flex items-end gap-2 rounded-[22px] border border-ink-600 bg-ink-950 py-1.5 pr-1.5 pl-3.5 focus-within:border-accent-500"
            onSubmit={(event) => {
              event.preventDefault()
              void ask(draft)
            }}
          >
            <textarea
              value={draft}
              rows={1}
              maxLength={2000}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void ask(draft)
                }
              }}
              className="max-h-32 min-h-6 flex-1 resize-none bg-transparent py-1.5 text-sm text-mist-100 outline-none [field-sizing:content]"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              aria-label={t('lore.send')}
              title={t('lore.send')}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-500 text-on-accent hover:bg-accent-400 disabled:opacity-40"
            >
              <Symbol name="chevronUp" />
            </button>
          </form>
          {footer}
        </div>
      </div>
    </div>
  )
}

function Answer({ turn, compact, conversation, note }: { turn: Turn; compact: boolean; conversation: number | null; note?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [lit, setLit] = useState<number | null>(null)
  const [open, setOpen] = useState<'sources' | 'way' | null>(null)
  const [copied, setCopied] = useState(false)
  const [working, setWorking] = useState<'note' | 'propose' | null>(null)
  const [made, setMade] = useState<{ kind: 'note'; path: string } | { kind: 'proposal' } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const told = useRef<HTMLDivElement>(null)
  // What became of saving or proposing stands below the answer: in a narrow window it would be out of sight.
  useEffect(() => {
    if (made || failed || open) told.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [made, failed, open])
  const act = (kind: 'note' | 'propose') => {
    if (conversation === null || turn.id === undefined) return
    setWorking(kind)
    setFailed(null)
    const done =
      kind === 'note'
        ? loreApi.saveNote(conversation, turn.id).then((saved) => setMade({ kind: 'note', path: saved.path }))
        : loreApi.propose(conversation, turn.id, note).then((proposed) => {
            setMade({ kind: 'proposal' })
            window.dispatchEvent(new CustomEvent(PROPOSALS_EVENT, { detail: proposed.path }))
          })
    void done.then(
      () => setWorking(null),
      (error) => {
        setWorking(null)
        setFailed(error instanceof ApiError ? error.code : 'internal_error')
      },
    )
  }
  const { body, missing } = answerParts(turn.text)
  const light = (number: number) => {
    setOpen('sources')
    setLit(number)
    window.setTimeout(() => setLit((now) => (now === number ? null : now)), 2000)
  }
  const searching = (() => {
    const last = turn.trace?.steps?.at(-1)
    return last?.tool === 'search' ? t('lore.searchingFor', { words: last.words }) : t('lore.searchingIn', { count: turn.trace?.spaces ?? 0 })
  })()
  const iconButton = 'grid h-7 w-7 place-items-center rounded-lg text-mist-500 hover:bg-ink-850 hover:text-accent-400 disabled:opacity-40'
  return (
    <div className={'group flex max-w-[94%] items-end gap-2 ' + (compact ? 'text-sm' : '')} data-testid="lore-answer">
      <LoreSpider className={'mb-0.5 shrink-0 ' + (compact ? 'h-6 w-7' : 'h-7 w-8')} />
      <div className="min-w-0 flex-1">
        <div className="rounded-[18px] rounded-bl-[5px] bg-ink-850 px-3.5 py-2.5 text-mist-100">
          {turn.pending && !turn.text && (
            <span className="nl-typing" role="status" aria-label={searching}>
              <i />
              <i />
              <i />
            </span>
          )}
          {body && (
            <div
              className={'nl-bubble ' + (turn.pending ? 'nl-caret' : '')}
              data-testid="lore-text"
              onClick={(event) => {
                const target = event.target as HTMLElement
                const chip = target.closest<HTMLElement>('button[data-source]')
                if (chip) {
                  light(Number(chip.dataset.source))
                  return
                }
                const link = target.closest<HTMLAnchorElement>('a[data-note]')
                if (link) {
                  event.preventDefault()
                  navigate(sourceUrl({ path: link.dataset.note!, heading: link.dataset.section ?? '' }))
                }
              }}
              dangerouslySetInnerHTML={{ __html: answerHtml(body, turn.sources) }}
            />
          )}
          {missing.map((line, index) => (
            <p key={index} className="mt-2 border-t border-dashed border-ink-600 pt-1.5 text-xs text-warn-500" data-testid="lore-missing">
              {t('lore.missing')} {line}
            </p>
          ))}
          {turn.error && (
            <p role="alert" className="text-sm text-bad-500">
              {errorText(turn.error)}
            </p>
          )}
        </div>
        {turn.pending && <p className="mt-1 ml-1 text-xs text-mist-500">{searching}</p>}
        {!turn.pending && (turn.sources.length > 0 || turn.trace || turn.text) && (
          <div className="mt-1 ml-1 flex flex-wrap items-center gap-x-3 text-xs text-mist-500">
            {turn.sources.length > 0 && (
              <button type="button" aria-expanded={open === 'sources'} onClick={() => setOpen(open === 'sources' ? null : 'sources')} className="hover:text-accent-400" data-testid="lore-sources-toggle">
                {open === 'sources' ? '▾' : '▸'} {t('lore.sourcesCount', { count: turn.sources.length })}
              </button>
            )}
            {turn.trace && (
              <button type="button" aria-expanded={open === 'way'} onClick={() => setOpen(open === 'way' ? null : 'way')} className="hover:text-accent-400" data-testid="lore-trace-toggle">
                {t('lore.way')}
              </button>
            )}
            {turn.text && (
              <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
                <button type="button" aria-label={copied ? t('lore.copied') : t('lore.copy')} title={copied ? t('lore.copied') : t('lore.copy')} onClick={() => void copyText(turn.text).then((ok) => ok && setCopied(true))} className={iconButton}>
                  <Symbol name={copied ? 'check' : 'copy'} className="h-3.5 w-3.5" />
                </button>
                {turn.id !== undefined && conversation !== null && !turn.error && (
                  <button type="button" aria-label={t('lore.saveNote')} title={t('lore.saveNote')} disabled={working !== null || made?.kind === 'note'} onClick={() => act('note')} className={iconButton}>
                    <Symbol name="note" className="h-3.5 w-3.5" />
                  </button>
                )}
                {note && turn.id !== undefined && conversation !== null && !turn.error && (
                  <button type="button" aria-label={t('lore.propose')} title={t('lore.propose')} disabled={working !== null || made?.kind === 'proposal'} onClick={() => act('propose')} className={iconButton}>
                    <Symbol name="pencil" className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            )}
          </div>
        )}
        {open === 'sources' && (
          <div className="mt-1.5 overflow-hidden rounded-xl border border-ink-700" data-testid="lore-sources">
            {turn.sources.map((source) => (
              <button
                key={source.n}
                type="button"
                data-card={source.n}
                onClick={() => navigate(sourceUrl(source))}
                className={'flex w-full items-baseline gap-2 border-t border-ink-700 px-2.5 py-1.5 text-left first:border-t-0 hover:bg-ink-850 ' + (lit === source.n ? 'bg-accent-500/10' : '')}
              >
                <span className="w-4 shrink-0 text-[11px] font-bold text-accent-400">{source.n}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-mist-100">
                  {source.title}
                  {source.heading && source.heading !== source.title && ` › ${source.heading}`}
                </span>
                {!compact && <span className="max-w-[40%] shrink-0 truncate text-[11px] text-mist-600">{source.path.split('/').slice(0, -1).join(' › ')}</span>}
              </button>
            ))}
          </div>
        )}
        {open === 'way' && turn.trace && (
          <dl className="mt-1.5 space-y-0.5 rounded-xl bg-ink-850 px-2.5 py-2 text-xs text-mist-500" data-testid="lore-trace">
            <div>
              {t('lore.traceIn', { count: turn.trace.spaces })}, {t('lore.traceNotes', { count: turn.trace.read.length })}
            </div>
            {turn.trace.words.length > 0 && (
              <div>
                <dt className="inline">{t('lore.traceWords')} </dt>
                <dd className="inline font-mono text-mist-300">{turn.trace.words.join(' · ')}</dd>
              </div>
            )}
            {(turn.trace.meant ?? []).length > 0 && (
              <div data-testid="lore-meant">
                <dt className="inline">{t('lore.traceMeant')} </dt>
                <dd className="inline text-mist-300">{turn.trace.meant!.join(', ')}</dd>
              </div>
            )}
            {turn.trace.read.length > 0 && (
              <div>
                <dt className="inline">{t('lore.traceRead')} </dt>
                <dd className="inline text-mist-300">{turn.trace.read.join(', ')}</dd>
              </div>
            )}
            {(turn.trace.steps ?? []).map((step, index) => (
              <div key={index} data-testid="lore-step">
                <dt className="inline">{t('lore.traceThen')} </dt>
                <dd className="inline text-mist-300">{step.tool === 'search' ? t('lore.stepSearch', { words: step.words, count: step.found }) : t('lore.stepRead', { n: step.n })}</dd>
              </div>
            ))}
          </dl>
        )}
        {made?.kind === 'note' && (
          <p role="status" className="mt-1 ml-1 text-xs text-accent-400" data-testid="lore-saved">
            {t('lore.saved')}{' '}
            <button type="button" onClick={() => navigate(noteUrl(made.path))} className="underline">
              {made.path.replace(/\.md$/i, '').split('/').join(' › ')}
            </button>
          </p>
        )}
        {made?.kind === 'proposal' && (
          <p role="status" className="mt-1 ml-1 text-xs text-accent-400" data-testid="lore-proposed">
            {t('lore.proposed')}
          </p>
        )}
        {working === 'propose' && <p className="mt-1 ml-1 text-xs text-mist-500">{t('lore.proposing')}</p>}
        {failed && (
          <p role="alert" className="mt-1 ml-1 text-xs text-bad-500">
            {errorText(failed)}
          </p>
        )}
        <div ref={told} />
      </div>
    </div>
  )
}
