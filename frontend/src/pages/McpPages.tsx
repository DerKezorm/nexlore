/**
 * The pages of the shared MCP module (mcp 1.1.0) in nexlore: "Programm verbinden" (the consent a program sends its
 * person to, `/oauth/authorize`, without the app around it) and the page of one waiting request
 * (`/mcp/requests/<id>`, where the bell and the card "KI-Werkzeuge (MCP)" lead).
 */
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import { KeyFactorHint } from '../components/KeyFactorHint'
import { mcpRequest, useMcpWords } from '../lib/mcpModule'
import { refreshNews } from '../lib/news'
import { ConsentPage, RequestPage } from '../vendor/nexmcp'

export function McpConsentPage() {
  const { t, i18n } = useTranslation()
  const words = useMcpWords()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 py-8">
      {/* Keys of an account that owes the second factor wait until it is set up; a connected program too. */}
      <div className="w-full max-w-md">
        <KeyFactorHint />
      </div>
      <ConsentPage request={mcpRequest} words={words} language={i18n.language} areaWord={t('apiTokens.spaces')} />
    </div>
  )
}

export function McpRequestRoute() {
  const { id = '' } = useParams()
  const { i18n } = useTranslation()
  const words = useMcpWords()
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <RequestPage request={mcpRequest} id={id} words={words} language={i18n.language} onDecided={() => void refreshNews()} />
    </div>
  )
}
