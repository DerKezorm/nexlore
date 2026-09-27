/** The own spaces: the right in each, members, leaving, deleting, and a new one. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { authApi, vaultApi } from '../../api/client'
import { useAuth } from '../../state/auth'
import { useStore } from '../../state/store'
import { ConfirmDialog } from '../ConfirmDialog'
import { MembersDialog } from '../MembersDialog'
import { SpaceOptionsDialog } from '../SpaceOptionsDialog'
import { Button, Card, Feedback } from './ui'
import { useAction } from './useAction'

export function SpacesCard() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const { spaces, reload } = useStore()
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string | null>(null)
  const [everyday, setEveryday] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const { busy, problem, run } = useAction()

  return (
    <Card id="spaces" symbol="users" title={t('settings.spaces.title')} text={t('settings.spaces.text')}>
      <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
        {spaces.map((space) => (
          <li key={space.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="font-medium">{space.name}</span>
            <span className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-mist-400">{t(`roles.${space.role}`)}</span>
            <span className="text-xs text-mist-500">{t('settings.spaces.count', { count: space.notes })}</span>
            <span className="ml-auto flex flex-wrap gap-1.5">
              {space.role === 'manage' && (
                <Button small onClick={() => setMembers(space.name)}>
                  {t('settings.spaces.members')}
                </Button>
              )}
              {space.role === 'manage' && (
                <Button small onClick={() => setEveryday(space.name)}>
                  {t('spaceOptions.button')}
                </Button>
              )}
              {space.role === 'manage' ? (
                <Button small danger onClick={() => setDeleting(space.name)}>
                  {t('settings.spaces.delete')}
                </Button>
              ) : (
                <Button
                  small
                  danger
                  busy={busy}
                  onClick={() => void run(async () => {
                    await authApi.removeMember(space.name, me!.name)
                    await reload()
                  })}
                >
                  {t('members.leave')}
                </Button>
              )}
            </span>
          </li>
        ))}
        {spaces.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">{t('settings.spaces.none')}</li>}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!name.trim()) return
          void run(async () => {
            await vaultApi.createSpace(name.trim())
            setName('')
            await reload()
          })
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('settings.spaces.newName')}
          aria-label={t('settings.spaces.newName')}
          className="h-9 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-850 px-3 text-sm outline-none focus:border-accent-500"
        />
        <Button type="submit" primary busy={busy}>
          {t('settings.spaces.create')}
        </Button>
      </form>
      <Feedback problem={problem} />
      {members && (
        <MembersDialog
          space={members}
          onClose={() => {
            setMembers(null)
            void reload()
          }}
        />
      )}
      {everyday && <SpaceOptionsDialog space={everyday} onClose={() => setEveryday(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title={t('settings.spaces.deleteTitle', { space: deleting ?? '' })}
        confirm={t('settings.spaces.delete')}
        danger
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void run(async () => {
          await authApi.deleteSpace(deleting!)
          setDeleting(null)
          await reload()
        })}
      >
        {t('settings.spaces.deleteText')}
      </ConfirmDialog>
    </Card>
  )
}
