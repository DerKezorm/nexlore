/**
 * The comments of a note, in the column beside it: threads on words of the note, open ones first, closed ones folded
 * away. A thread's words lead to their place in the text; a thread whose words are gone says so. Anyone who may read
 * the note comments and answers; `@name` offers the people of the space. Nothing of it goes into the file.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, commentsApi, type Thread } from '../api/client'
import { typingMention, withMentions, type Anchor } from '../lib/comments'
import { errorText } from '../lib/errors'
import { formatDate } from '../lib/markdown'
import { Symbol } from './Symbol'

type Props = {
  path: string
  threads: Thread[] | null
  /** A new thread asked for from words chosen in the text; null without one. */
  draft: Anchor | null
  onDraftDone: () => void
  /** Whether each thread's words are still in the text (by id); undefined while the text is not shown. */
  found?: Set<number>
  /** Scroll to a thread's words in the text. */
  onReveal: (thread: Thread) => void
  /** Anything changed: the threads are asked again. */
  onChanged: () => void
  /** A manager of the space may take back anyone's comment. */
  manage: boolean
  /** A thread asked for from its words in the text: scrolled to and lit (a counter, so the same one twice works). */
  focus?: { id: number; ask: number } | null
}

/** A text field that offers the names of the space after `@`. */
function MentionBox({ path, value, onChange, onSubmit, label, autoFocus }: {
  path: string; value: string; onChange: (next: string) => void; onSubmit: () => void; label: string; autoFocus?: boolean
}) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [names, setNames] = useState<string[]>([])
  const [typed, setTyped] = useState<{ start: number; words: string } | null>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (!typed) return setNames([])
    let alive = true
    const timer = window.setTimeout(() => {
      commentsApi.people(path, typed.words).then((found) => alive && (setNames(found), setActive(0)), () => {})
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [path, typed])

  const take = (name: string) => {
    if (!typed) return
    const caret = field.current?.selectionStart ?? value.length
    const next = value.slice(0, typed.start) + '@' + name + ' ' + value.slice(caret)
    onChange(next)
    setTyped(null)
    caretAt.current = typed.start + name.length + 2
  }
  // The caret after the name, set as soon as the new text is drawn: a frame later, a quick next key had already
  // landed at the end and the caret jumped back before it (seen in the CI: "@tester ure?s").
  const caretAt = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (caretAt.current === null) return
    field.current?.setSelectionRange(caretAt.current, caretAt.current)
    field.current?.focus()
    caretAt.current = null
  }, [value])

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (names.length && typed) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : names.length - 1)) % names.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        take(names[active])
        return
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        setTyped(null)
        return
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={field}
        value={value}
        autoFocus={autoFocus}
        aria-label={label}
        rows={3}
        onChange={(event) => {
          onChange(event.target.value)
          setTyped(typingMention(event.target.value, event.target.selectionStart))
        }}
        onKeyDown={keys}
        onBlur={() => window.setTimeout(() => setTyped(null), 150)}
        className="w-full resize-y rounded-lg border border-ink-700 bg-ink-950 p-2 text-sm text-mist-100 outline-none focus:border-accent-500"
      />
      {typed && names.length > 0 && (
        <ul role="listbox" aria-label={label} className="absolute z-10 mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 p-1 shadow-xl">
          {names.map((name, index) => (
            <li key={name} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => take(name)}
                className={'block w-full rounded-md px-2 py-1 text-left text-sm ' + (index === active ? 'bg-accent-500/15 text-mist-100' : 'text-mist-300 hover:bg-ink-850')}
              >
                @{name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Words({ body, known }: { body: string; known: (name: string) => boolean }) {
  return (
    <p className="mt-0.5 text-sm break-words whitespace-pre-wrap text-mist-200">
      {withMentions(body).map((part, index) =>
        part.mention && known(part.text.slice(1)) ? (
          <span key={index} className="rounded bg-accent-500/15 px-0.5 text-accent-300">
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  )
}

export function Comments({ path, threads, draft, onDraftDone, found, onReveal, onChanged, manage, focus }: Props) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [reply, setReply] = useState('')
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lit, setLit] = useState<{ id: number; ask: number } | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const picks = useRef(0)
  // Which @names are somebody here: only those are marked (an @ with no account looked like a mention, P6.18).
  const [known, setKnown] = useState<Map<string, boolean>>(new Map())
  const mentioned = useMemo(
    () => [...new Set((threads ?? []).flatMap((thread) => thread.comments.flatMap((comment) => withMentions(comment.body).filter((part) => part.mention).map((part) => part.text.slice(1).toLowerCase()))))],
    [threads],
  )
  useEffect(() => {
    let live = true
    for (const name of mentioned) {
      if (known.has(name)) continue
      commentsApi.people(path, name).then(
        (found) => live && setKnown((map) => new Map(map).set(name, found.some((one) => one.toLowerCase() === name))),
        () => undefined,
      )
    }
    return () => {
      live = false
    }
  }, [mentioned, path, known])
  const isKnown = (name: string) => known.get(name.toLowerCase()) === true

  // A thread asked for from the text: in sight, and lit a moment.
  useEffect(() => {
    if (!focus || !threads) return
    const wanted = threads.find((thread) => thread.id === focus.id)
    if (!wanted) return
    if (wanted.resolved) setShowClosed(true)
    setLit({ id: focus.id, ask: focus.ask })
    const frame = requestAnimationFrame(() =>
      list.current?.querySelector(`[data-thread="${focus.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [focus, threads])

  /** A click on a thread (not on its buttons or fields) goes to its words in the text. */
  const pick = (thread: Thread, target: EventTarget) => {
    if ((target as HTMLElement).closest('button, textarea, input, a, [role="listbox"]')) return
    picks.current += 1
    setLit({ id: thread.id, ask: -picks.current })
    onReveal(thread)
  }

  const act = async (action: () => Promise<unknown>, after?: () => void) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await action()
      after?.()
      onChanged()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    } finally {
      setBusy(false)
    }
  }

  const open = threads?.filter((thread) => !thread.resolved) ?? []
  const closed = threads?.filter((thread) => thread.resolved) ?? []

  const card = (thread: Thread) => (
    <li
      key={lit?.id === thread.id ? `${thread.id}-${lit.ask}` : thread.id}
      className={'cursor-pointer rounded-xl border border-ink-700 bg-ink-900 p-3 hover:border-ink-600' + (lit?.id === thread.id ? ' nx-thread-lit' : '')}
      data-thread={thread.id}
      data-lit={lit?.id === thread.id || undefined}
      onClick={(event) => pick(thread, event.target)}
    >
      <button
        type="button"
        onClick={() => onReveal(thread)}
        title={t('comments.reveal')}
        className="block w-full truncate border-l-2 border-accent-500/60 pl-2 text-left text-xs text-mist-400 italic hover:text-mist-200"
      >
        {thread.quote}
      </button>
      {found && !found.has(thread.id) && <p className="mt-1 text-xs text-warn-500">{t('comments.gone')}</p>}
      <ul className="mt-2 space-y-2">
        {thread.comments.map((comment) => (
          <li key={comment.id} data-comment={comment.id}>
            <div className="flex items-baseline gap-2 text-xs text-mist-500">
              <span className="font-semibold text-mist-300">{comment.author}</span>
              <span title={comment.created_at}>{formatDate(comment.created_at)}</span>
              {comment.edited_at && <span>{t('comments.edited')}</span>}
              <span className="ml-auto flex gap-1">
                {comment.mine && (
                  <button type="button" onClick={() => setEditing({ id: comment.id, body: comment.body })} className="hover:text-mist-200">
                    {t('comments.edit')}
                  </button>
                )}
                {(comment.mine || manage) && (
                  <button type="button" onClick={() => void act(() => commentsApi.remove(path, comment.id))} className="hover:text-bad-500">
                    {t('comments.remove')}
                  </button>
                )}
              </span>
            </div>
            {editing?.id === comment.id ? (
              <div className="mt-1 space-y-1">
                <MentionBox path={path} value={editing.body} onChange={(body) => setEditing({ id: comment.id, body })} onSubmit={() => void act(() => commentsApi.edit(path, comment.id, editing.body), () => setEditing(null))} label={t('comments.editLabel')} autoFocus />
                <div className="flex justify-end gap-2 text-xs">
                  <button type="button" onClick={() => setEditing(null)} className="text-mist-400 hover:text-mist-100">{t('common.cancel')}</button>
                  <button type="button" onClick={() => void act(() => commentsApi.edit(path, comment.id, editing.body), () => setEditing(null))} className="font-semibold text-accent-400">{t('comments.save')}</button>
                </div>
              </div>
            ) : (
              <Words body={comment.body} known={isKnown} />
            )}
          </li>
        ))}
      </ul>
      {replyTo === thread.id ? (
        <div className="mt-2 space-y-1">
          <MentionBox path={path} value={reply} onChange={setReply} onSubmit={() => void act(() => commentsApi.reply(path, thread.id, reply), () => (setReply(''), setReplyTo(null)))} label={t('comments.replyLabel')} autoFocus />
          <div className="flex justify-end gap-2 text-xs">
            <button type="button" onClick={() => setReplyTo(null)} className="text-mist-400 hover:text-mist-100">{t('common.cancel')}</button>
            <button type="button" disabled={!reply.trim()} onClick={() => void act(() => commentsApi.reply(path, thread.id, reply), () => (setReply(''), setReplyTo(null)))} className="font-semibold text-accent-400 disabled:opacity-40">{t('comments.send')}</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-3 text-xs">
          <button type="button" onClick={() => (setReplyTo(thread.id), setReply(''))} className="text-mist-400 hover:text-mist-100">
            {t('comments.reply')}
          </button>
          {thread.may_resolve && (
            <button type="button" onClick={() => void act(() => commentsApi.resolve(path, thread.id, !thread.resolved))} className="text-mist-400 hover:text-mist-100">
              {thread.resolved ? t('comments.reopen') : t('comments.resolve')}
            </button>
          )}
          {thread.resolved && <span className="ml-auto text-mist-600">{t('comments.resolvedBy', { name: thread.resolved_by })}</span>}
        </div>
      )}
    </li>
  )

  return (
    <div ref={list} className="space-y-3 px-2" data-testid="comments">
      {draft && (
        <div className="rounded-xl border border-accent-500/50 bg-accent-500/5 p-3">
          <p className="mb-2 truncate border-l-2 border-accent-500/60 pl-2 text-xs text-mist-400 italic">{draft.quote}</p>
          <MentionBox path={path} value={text} onChange={setText} onSubmit={() => void act(() => commentsApi.start(path, draft, text), () => (setText(''), onDraftDone()))} label={t('comments.newLabel')} autoFocus />
          <div className="mt-1 flex justify-end gap-2 text-xs">
            <button type="button" onClick={() => (setText(''), onDraftDone())} className="text-mist-400 hover:text-mist-100">{t('common.cancel')}</button>
            <button type="button" disabled={!text.trim() || busy} onClick={() => void act(() => commentsApi.start(path, draft, text), () => (setText(''), onDraftDone()))} className="font-semibold text-accent-400 disabled:opacity-40">{t('comments.send')}</button>
          </div>
        </div>
      )}
      {problem && <p role="alert" className="text-sm text-warn-500">{problem}</p>}
      {threads === null && <p className="text-sm text-mist-600">{t('common.loading')}</p>}
      {threads?.length === 0 && !draft && <p className="text-sm text-mist-600">{t('comments.none')}</p>}
      <ul className="space-y-3">{open.map(card)}</ul>
      {closed.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed} className="flex items-center gap-1 text-xs text-mist-500 hover:text-mist-200">
            <Symbol name={showClosed ? 'chevronDown' : 'chevronRight'} className="h-3 w-3" />
            {t('comments.closed', { count: closed.length })}
          </button>
          {showClosed && <ul className="mt-2 space-y-3 opacity-80">{closed.map(card)}</ul>}
        </div>
      )}
    </div>
  )
}
