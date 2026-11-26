/**
 * The operator's part of the settings: accounts and invitations, every space (rights only, never contents),
 * sign-in and the provider, public pages, mail, files, languages.
 */
import { Gauge, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import {
  adminApi,
  type AdminSpace,
  type FileSettings,
  type ServerSettings,
  type ShareInfo,
  shareApi,
} from '../../api/client'
import { pastedExample } from '../../lib/pastedName'
import { formatDay } from '../../lib/markdown'
import { useAuth } from '../../state/auth'
import { useStore } from '../../state/store'
import { noteUrl } from '../../lib/vault'
import { MembersDialog } from '../MembersDialog'
import { Button, Card, Feedback, Input, Select, Toggle } from './ui'
import { useAction } from './useAction'

// --- Accounts and invitations ---------------------------------------------------------------------------------------

/** The operator's list of accounts: the shared account module's (konten 0.3.9/0.3.10), in its own file. */
export { AccountsCard } from '../../pages/settings/AccountsList'

// --- Every space ----------------------------------------------------------------------------------------------------

export function AllSpacesCard() {
  const { t } = useTranslation()
  const [spaces, setSpaces] = useState<AdminSpace[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const { problem, run } = useAction()

  const load = useCallback(async () => setSpaces(await adminApi.spaces()), [])
  useEffect(() => {
    void run(load)
  }, [run, load])

  return (
    <Card id="all-spaces" symbol="space" title={t('admin.spaces.title')} text={t('admin.spaces.text')}>
      <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
        {spaces.map((space) => (
          <li key={space.name} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="font-medium">{space.name}</span>
            <span className="text-xs text-mist-500">
              {space.members === 0
                ? t('admin.spaces.yours')
                : t('admin.spaces.members', { count: space.members, managers: space.managers.join(', ') || '–' })}
            </span>
            <span className="ml-auto">
              <Button small onClick={() => setOpen(space.name)}>
                {t('admin.spaces.rights')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <Feedback problem={problem} />
      {open && (
        <MembersDialog
          space={open}
          onClose={() => {
            setOpen(null)
            void run(load)
          }}
        />
      )}
    </Card>
  )
}

// --- AI from outside (MCP, M7) ----------------------------------------------------------------------------------------

// --- The guide (the space "nexlore") ------------------------------------------------------------------------------------

/** The guide's start note in each language (`backend/app/guide`). */
const GUIDE_START: Record<string, string> = { de: '00 Willkommen.md', en: '00 Welcome.md' }

export function GuideCard() {
  const { t, i18n } = useTranslation()
  const { reload } = useStore()
  const [language, setLanguage] = useState(i18n.language.startsWith('de') ? 'de' : 'en')
  const [made, setMade] = useState<{ space: string; language: string } | null>(null)
  const { busy, problem, run } = useAction()
  return (
    <Card id="guide" symbol="book" title={t('admin.guide.title')} text={t('admin.guide.text')}>
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t('admin.guide.language')}
          value={language}
          options={[{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'English' }]}
          onChange={setLanguage}
        />
        <Button
          primary
          busy={busy}
          onClick={() =>
            void run(async () => {
              const answer = await adminApi.makeGuide(language)
              setMade({ space: answer.space, language })
              await reload()
            })
          }
        >
          {t('admin.guide.make')}
        </Button>
      </div>
      {made && (
        <p role="status" className="mt-3 text-sm text-accent-400">
          {t('admin.guide.made', { space: made.space })}{' '}
          <Link to={noteUrl(`${made.space}/${GUIDE_START[made.language]}`)} className="underline">
            {t('admin.guide.open')}
          </Link>
        </p>
      )}
      <Feedback problem={problem} />
    </Card>
  )
}

// --- AI in notes, with each account's own service ---------------------------------------------------------------------

// --- Own CSS of the accounts --------------------------------------------------------------------------------------

export function CssCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const { problem, run } = useAction()
  const save = (value: boolean) => {
    onChange({ ...settings, custom_css_allowed: value })
    void run(async () => {
      onChange(await adminApi.saveSettings({ custom_css_allowed: value }))
      await refresh()
    }).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="css" symbol="code" title={t('admin.css.title')} text={t('admin.css.text')}>
      <Toggle label={t('admin.css.allow')} hint={t('admin.css.allowHint')} checked={settings.custom_css_allowed} onChange={save} />
      <Feedback problem={problem} />
    </Card>
  )
}

// --- Public pages ---------------------------------------------------------------------------------------------------

export function SharesCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [shares, setShares] = useState<ShareInfo[]>([])
  const { busy, problem, run } = useAction()
  const load = useCallback(async () => setShares(await adminApi.shares()), [])
  useEffect(() => {
    void run(load)
  }, [run, load])

  return (
    <Card id="shares" symbol="globe" title={t('admin.shares.title')} text={t('admin.shares.text')}>
      <Toggle
        label={t('admin.shares.allow')}
        hint={t('admin.shares.allowHint')}
        checked={settings.shares_allowed}
        onChange={(value) => {
          onChange({ ...settings, shares_allowed: value })
          void run(async () => {
            onChange(await adminApi.saveSettings({ shares_allowed: value }))
            // The share buttons read it from the own account.
            await refresh()
          }).then((ok) => ok || onChange(settings))
        }}
      />
      <ul className="mt-3 divide-y divide-ink-700 rounded-xl border border-ink-700 text-sm">
        {shares.map((share) => (
          <li key={share.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{share.path}</span>
              <span className="ml-2 text-xs text-mist-500">
                {share.by ?? '–'}
                {share.expires_at ? ` · ${t('members.invite.until', { when: formatDay(share.expires_at) })}` : ''}
                {share.password ? ` · ${t('share.withPassword')}` : ''}
              </span>
            </span>
            <a href={share.link} target="_blank" rel="noreferrer" className="text-xs text-accent-400 hover:underline">
              {t('share.open')}
            </a>
            <Button small danger busy={busy} onClick={() => void run(async () => {
              await shareApi.withdraw(share.id)
              await load()
            })}>
              {t('share.withdraw')}
            </Button>
          </li>
        ))}
        {shares.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">{t('admin.shares.none')}</li>}
      </ul>
      <Feedback problem={problem} />
    </Card>
  )
}

/** "Funktionen für alle Konten" (plan "Einstellungen", Allgemein 2): what the operator opens for every account. In
 * nexlore: the calendar subscriptions (the switch stood in "AI, API and plugins" before). */
export function FeaturesCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { problem, run } = useAction()
  const save = (value: boolean) => {
    onChange({ ...settings, calendar_feed_allowed: value })
    void run(async () => onChange(await adminApi.saveSettings({ calendar_feed_allowed: value }))).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="features" icon={SlidersHorizontal} title={t('admin.features.title')} text={t('admin.features.text')}>
      <div id="calendar-feed">
        <Toggle label={t('feed.allow')} hint={t('feed.allowHint')} checked={settings.calendar_feed_allowed} onChange={save} />
      </div>
      <Feedback problem={problem} />
    </Card>
  )
}

/** ``quota_mb`` as nexlore stores it (MB, the old way), shown in GB as the other apps show it; 0 is no limit (empty). */
function shownGigabytes(megabytes: number): string {
  return megabytes ? String(Math.round((megabytes / 1024) * 100) / 100) : ''
}

export function FilesSettingsCard() {
  const { t } = useTranslation()
  const [values, setValues] = useState<FileSettings | null>(null)
  // The folder name as stored: a new one may take the folders already there along.
  const [stored, setStored] = useState('')
  const [renameExisting, setRenameExisting] = useState(true)
  const [report, setReport] = useState<string | null>(null)
  // What is typed in "Storage for new accounts (GB)" while it is typed ("2." stays as it is); null: from the server.
  const [gigabytes, setGigabytes] = useState<string | null>(null)
  const { busy, problem, done, run } = useAction()
  useEffect(() => {
    void run(async () => {
      const found = await adminApi.fileSettings()
      setValues(found)
      setStored(found.attachment_folder)
    })
  }, [run])
  if (!values) return null
  const renamed = values.attachment_folder.trim() !== stored
  return (
    <Card id="limits" icon={Gauge} title={t('admin.files.limitsTitle')} text={`${t('admin.files.text')} ${t('admin.files.perAccount')}`}>
      <form
        className="grid gap-2 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault()
          setReport(null)
          void run(async () => {
            const saved = await adminApi.saveFileSettings({ ...values, rename_existing: renamed && renameExisting })
            const { renamed: count, left, ...rest } = saved
            setValues(rest)
            setGigabytes(null)
            setStored(rest.attachment_folder)
            const lines = [
              ...(count ? [t('admin.files.renamed', { count })] : []),
              ...(left.length ? [t('admin.files.left', { count: left.length, list: left.join(', ') })] : []),
            ]
            setReport(lines.length ? lines.join(' ') : null)
          }, t('common.saved'))
        }}
      >
        <Input label={t('admin.files.folder')} value={values.attachment_folder} onChange={(attachment_folder) => setValues({ ...values, attachment_folder })} />
        <Input label={t('admin.files.perFile')} value={String(values.upload_max_mb)} onChange={(value) => setValues({ ...values, upload_max_mb: Number(value) || 1 })} type="number" />
        {/* Plan E44: the start of every new account, in GB as nexnotes, nexpaper and nexdiary show it; stored in MB as
            before (quota_mb, the old way unchanged); empty (0) is no limit. */}
        <Input label={t('admin.files.quota')} value={gigabytes ?? shownGigabytes(values.quota_mb)} onChange={(value) => {
          setGigabytes(value)
          setValues({ ...values, quota_mb: Math.max(0, Math.round(Number(value) * 1024)) || 0 })
        }} type="number" hint={t('admin.files.quotaHint')} testId="limits-new-accounts" />
        {renamed && (
          <div className="sm:col-span-3">
            <Toggle
              label={t('admin.files.renameExisting')}
              hint={t('admin.files.renameExistingHint', { old: stored })}
              checked={renameExisting}
              onChange={setRenameExisting}
            />
          </div>
        )}
        <div className="sm:col-span-3">
          <Input
            label={t('admin.files.pasted')}
            value={values.pasted_name}
            onChange={(pasted_name) => setValues({ ...values, pasted_name })}
            hint={t('admin.files.pastedHint', { example: `${values.attachment_folder.trim()}/${pastedExample(values.pasted_name, t('admin.files.pastedNote'), new Date())}.png` })}
          />
        </div>
        <div className="sm:col-span-3">
          <Input
            label={t('admin.files.uploaded')}
            value={values.uploaded_name}
            onChange={(uploaded_name) => setValues({ ...values, uploaded_name })}
            hint={t('admin.files.uploadedHint', {
              example: `${values.attachment_folder.trim()}/${pastedExample(values.uploaded_name, t('admin.files.pastedNote'), new Date(), t('admin.files.uploadedFile'))}.pdf`,
            })}
          />
        </div>
        <div className="sm:col-span-3">
          <Toggle label={t('admin.files.strip')} hint={t('admin.files.stripHint')} checked={values.strip_location} onChange={(strip_location) => setValues({ ...values, strip_location })} />
        </div>
        <div className="sm:col-span-3">
          {/* Save of a field as nexnotes has it under "Limits": secondary (plan, joint round). */}
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <Feedback problem={problem} done={done && report ? `${done} ${report}` : done} />
    </Card>
  )
}

