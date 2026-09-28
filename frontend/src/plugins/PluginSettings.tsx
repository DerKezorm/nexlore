/**
 * Plugins in the settings (M7). The operator installs from the catalog and lets out (`AdminPluginsCard`); a file of
 * one's own only behind the latch, and only after a plain warning, when the latch is opened and before each upload:
 * code nobody checked could send what it is shown elsewhere through WebRTC, which no Content Security Policy blocks in
 * every browser. Each account switches let-out plugins on for itself (`MyPluginsCard`).
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { adminApi, api, type ServerSettings } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Symbol } from '../components/Symbol'
import { Button, Card, Feedback, Toggle } from '../components/settings/ui'
import { useAction } from '../components/settings/useAction'
import { pluginsApi, pluginsChanged, pluginText, type PluginInfo } from './registry'

type Installed = PluginInfo & { approved: boolean; installed_at: string; installed_by: string | null; users: number }
type AdminList = { catalog: PluginInfo[]; installed: Installed[]; upload_allowed: boolean }

const adminPlugins = {
  list: () => api<AdminList>('/api/admin/plugins'),
  install: (id: string) => api<PluginInfo>(`/api/admin/plugins/${id}/install`, { method: 'POST' }),
  approve: (id: string, approved: boolean) => api<PluginInfo>(`/api/admin/plugins/${id}`, { method: 'PUT', body: { approved } }),
  remove: (id: string) => api<void>(`/api/admin/plugins/${id}`, { method: 'DELETE' }),
  upload: (manifest: unknown, code: string) => api<PluginInfo>('/api/admin/plugins', { method: 'POST', body: { manifest, code } }),
}

function Permissions({ plugin }: { plugin: PluginInfo }) {
  const { t } = useTranslation()
  const allowed = plugin.permissions.map((permission) => t(`plugins.permission.${permission.replace(':', '_')}`)).join(', ')
  return (
    <p className="mt-1 flex items-center gap-1 text-[11px] text-mist-500">
      <Symbol name="shield" className="h-3.5 w-3.5 shrink-0" />
      {t('plugins.may', { what: allowed || t('plugins.nothing') })}
    </p>
  )
}

export function AdminPluginsCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t, i18n } = useTranslation()
  const [list, setList] = useState<AdminList | null>(null)
  const [files, setFiles] = useState<{ manifest: File | null; code: File | null }>({ manifest: null, code: null })
  const [asking, setAsking] = useState<'latch' | 'upload' | null>(null)
  const { busy, problem, done, run } = useAction()
  const load = useCallback(async () => setList(await adminPlugins.list()), [])
  useEffect(() => {
    void run(load)
  }, [run, load])

  const change = (work: () => Promise<unknown>) =>
    void run(async () => {
      await work()
      await load()
      pluginsChanged()
    })

  const latch = (value: boolean) => {
    onChange({ ...settings, plugin_upload_allowed: value })
    void run(async () => {
      onChange(await adminApi.saveSettings({ plugin_upload_allowed: value }))
      await load()
    }).then((ok) => ok || onChange(settings))
  }
  const upload = () => {
    const { manifest, code } = files
    if (!manifest || !code) return
    change(async () => adminPlugins.upload(JSON.parse(await manifest.text()), await code.text()))
  }

  const installed = new Map((list?.installed ?? []).map((plugin) => [plugin.id, plugin]))
  const own = (list?.installed ?? []).filter((plugin) => plugin.source === 'upload')
  return (
    <Card id="plugins" symbol="plug" title={t('admin.plugins.title')} text={t('admin.plugins.text')}>
      <ul className="space-y-2">
        {[...(list?.catalog ?? []), ...own].map((plugin) => {
          const here = installed.get(plugin.id)
          return (
            <li key={plugin.id} className="rounded-xl border border-ink-700 p-3" data-testid={`plugin-${plugin.id}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-mist-100">{pluginText(plugin.name, i18n.language)}</span>
                <span className="text-xs text-mist-500">
                  {plugin.version} · {plugin.source === 'upload' ? t('admin.plugins.own') : plugin.author}
                </span>
                {here && (
                  <span className={'rounded-full px-2 py-0.5 text-[11px] ' + (here.approved ? 'bg-accent-500/15 text-accent-400' : 'bg-ink-800 text-mist-400')}>
                    {here.approved ? t('admin.plugins.letOut', { count: here.users }) : t('admin.plugins.installed')}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-mist-400">{pluginText(plugin.description, i18n.language)}</p>
              <Permissions plugin={plugin} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!here ? (
                  <Button small busy={busy} onClick={() => change(() => adminPlugins.install(plugin.id))}>
                    {t('admin.plugins.install')}
                  </Button>
                ) : (
                  <>
                    <Button small primary={!here.approved} busy={busy} onClick={() => change(() => adminPlugins.approve(plugin.id, !here.approved))}>
                      {here.approved ? t('admin.plugins.holdBack') : t('admin.plugins.letOutDo')}
                    </Button>
                    {here.source === 'catalog' && here.version !== plugin.version && (
                      <Button small busy={busy} onClick={() => change(() => adminPlugins.install(plugin.id))}>
                        {t('admin.plugins.update', { version: plugin.version })}
                      </Button>
                    )}
                    <Button small danger busy={busy} onClick={() => change(() => adminPlugins.remove(plugin.id))}>
                      {t('admin.plugins.remove')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-4 rounded-xl border border-dashed border-ink-700 p-3">
        <Toggle
          label={t('admin.plugins.uploadAllow')}
          hint={t('admin.plugins.uploadHint')}
          checked={settings.plugin_upload_allowed}
          onChange={(value) => (value ? setAsking('latch') : latch(false))}
        />
        {settings.plugin_upload_allowed && (
          <p role="note" data-testid="plugin-upload-warning" className="mt-3 flex gap-2 rounded-lg border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
            <Symbol name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('admin.plugins.warnShort')}
          </p>
        )}
        {settings.plugin_upload_allowed && (
          <form
            className="mt-3 grid gap-2 text-xs text-mist-400 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (files.manifest && files.code) setAsking('upload')
            }}
          >
            <label className="block">
              manifest.json
              <input type="file" accept=".json,application/json" onChange={(event) => setFiles((f) => ({ ...f, manifest: event.target.files?.[0] ?? null }))} className="mt-1 block w-full text-xs" />
            </label>
            <label className="block">
              main.js
              <input type="file" accept=".js,text/javascript" onChange={(event) => setFiles((f) => ({ ...f, code: event.target.files?.[0] ?? null }))} className="mt-1 block w-full text-xs" />
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" small busy={busy}>
                {t('admin.plugins.upload')}
              </Button>
            </div>
          </form>
        )}
      </div>
      <Feedback problem={problem} done={done} />
      <ConfirmDialog
        open={asking !== null}
        danger
        title={asking === 'upload' ? t('admin.plugins.uploadTitle') : t('admin.plugins.warnTitle')}
        confirm={asking === 'upload' ? t('admin.plugins.uploadConfirm') : t('admin.plugins.warnConfirm')}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          const what = asking
          setAsking(null)
          if (what === 'upload') upload()
          else latch(true)
        }}
      >
        <p>{asking === 'upload' ? t('admin.plugins.uploadText') : t('admin.plugins.warnText')}</p>
      </ConfirmDialog>
    </Card>
  )
}

/** On the account page: the plugins the operator let out, each switched on or off for oneself. */
export function MyPluginsCard() {
  const { t, i18n } = useTranslation()
  const [list, setList] = useState<PluginInfo[] | null>(null)
  const { problem, run } = useAction()
  useEffect(() => {
    void pluginsApi.mine().then(setList, () => setList([]))
  }, [])
  if (!list?.length) return null
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5" aria-labelledby="my-plugins">
      <h2 id="my-plugins" className="mb-1 flex items-center gap-2 font-semibold">
        <Symbol name="plug" className="h-4 w-4 text-accent-400" /> {t('plugins.mine')}
      </h2>
      <p className="mb-4 text-sm text-mist-500">{t('plugins.mineText')}</p>
      <ul className="space-y-2">
        {list.map((plugin) => (
          <li key={plugin.id} className="rounded-xl border border-ink-700 p-3">
            <Toggle
              label={pluginText(plugin.name, i18n.language)}
              hint={pluginText(plugin.description, i18n.language)}
              checked={plugin.enabled}
              onChange={(enabled) =>
                void run(async () => {
                  const changed = await pluginsApi.enable(plugin.id, enabled)
                  setList((items) => items?.map((item) => (item.id === plugin.id ? changed : item)) ?? null)
                  pluginsChanged()
                })
              }
            />
            <Permissions plugin={plugin} />
          </li>
        ))}
      </ul>
      <Feedback problem={problem} />
    </section>
  )
}
