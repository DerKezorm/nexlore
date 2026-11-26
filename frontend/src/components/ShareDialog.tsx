/** Putting a note or folder on a public page: the links it has, and a new one with an end date and a password. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showModalOnce } from '../lib/dialog'

import { shareApi, type ShareInfo } from '../api/client'
import { formatDay } from '../lib/markdown'
import { Button, CopyLink, Feedback, Input, Select } from './settings/ui'
import { useAction } from './settings/useAction'
import { Symbol } from './Symbol'

const ENDS = ['0', '1', '7', '30', '365'] as const

/** `path`: the note; `folder`: the folder it lies in, offered as the other thing to share. */
export function ShareDialog({ path: note, folder, onClose }: { path: string; folder?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [path, setPath] = useState(note)
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [ends, setEnds] = useState<(typeof ENDS)[number]>('0')
  const [password, setPassword] = useState('')
  const { busy, problem, run } = useAction()

  const load = useCallback(() => run(async () => setShares(await shareApi.of(path))), [run, path])
  useEffect(() => {
    showModalOnce(dialog.current)
    void load()
  }, [load])

  return (
    <dialog
      ref={dialog}
      aria-labelledby="share-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id="share-title" className="text-base font-semibold text-mist-100">
            {t('share.title')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-full p-1 text-mist-500 hover:bg-ink-850">
            <Symbol name="close" />
          </button>
        </div>
        <p className="mt-1 text-sm text-mist-500">{t('share.text')}</p>
        {folder && (
          <div className="mt-3 flex flex-wrap gap-2 text-sm" role="radiogroup" aria-label={t('share.what')}>
            {[note, folder].map((option) => (
              <label key={option} className={'flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 ' + (path === option ? 'border-accent-500 bg-accent-500/10' : 'border-ink-700')}>
                <input type="radio" name="share-what" checked={path === option} onChange={() => setPath(option)} className="accent-accent-500" />
                {option === note ? t('share.thisNote') : t('share.thisFolder', { folder: option })}
              </label>
            ))}
          </div>
        )}

        {shares.length > 0 && (
          <ul className="mt-4 space-y-3">
            {shares.map((share) => (
              <li key={share.id} className="space-y-1">
                <CopyLink link={share.link} label={t('members.invite.copy')} />
                <div className="flex items-center gap-2 text-xs text-mist-500">
                  <span className="flex-1">
                    {share.expires_at ? t('members.invite.until', { when: formatDay(share.expires_at) }) : t('share.noEnd')}
                    {share.password ? ` · ${t('share.withPassword')}` : ''}
                  </span>
                  <Button small danger busy={busy} onClick={() => void run(async () => {
                    await shareApi.withdraw(share.id)
                    await load()
                  })}>
                    {t('share.withdraw')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form
          className="mt-4 grid gap-2 border-t border-ink-700 pt-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await shareApi.create(path, ends === '0' ? null : Number(ends), password)
              setPassword('')
              await load()
            })
          }}
        >
          <Select
            label={t('share.ends')}
            value={ends}
            options={ENDS.map((value) => ({ value, label: value === '0' ? t('share.noEnd') : t('members.invite.days', { count: Number(value) }) }))}
            onChange={setEnds}
          />
          <Input label={t('share.password')} value={password} onChange={setPassword} type="password" autoComplete="new-password" hint={t('share.passwordHint')} />
          <div className="sm:col-span-2">
            <Button type="submit" primary busy={busy}>
              <Symbol name="globe" /> {t('share.create')}
            </Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-mist-500">{t('share.leaves')}</p>
        <Feedback problem={problem} />
      </div>
    </dialog>
  )
}
