/**
 * Server › Log: the card "Log" of the shared module log (`vendor/nexlog`, bauplaene/log 1.0.0), built from the ui kit.
 * nexlore hands it its client and its word for what it keeps. Nothing secret is written to the log (a scan in the
 * tests sees to that, the module blacks out keys and tokens beneath it), so reading it here shows nothing new about
 * anyone.
 */
import { useTranslation } from 'react-i18next'

import { api } from '../../api/client'
import { LogCard as SharedLogCard } from '../../vendor/nexlog/LogCard'
import type { LogRequest } from '../../vendor/nexlog/log'

const request: LogRequest = <T,>(path: string, init: Parameters<LogRequest>[1] = {}) => api<T>(path, init)

export function LogCard() {
  const { t } = useTranslation()
  return <SharedLogCard request={request} base="/api/logs" things={t('settings.things')} />
}
