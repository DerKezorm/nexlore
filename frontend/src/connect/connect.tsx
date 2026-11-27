/**
 * nexlore's side of the shared module verbinden (`vendor/nexverbinden` 0.2.0) in the page: its client for the module's
 * routes (`/api/connect`, with the tab in every request), the cards of the partner apps under Mein Konto ›
 * Verbindungen, the operator's card "Andere nex-Apps" under Server › Verbindungen, and the pages of the consent
 * (`/connect/app`) and the return (`/connect/return`). nexlore is only the host: nexnotes puts notes into its spaces
 * (`notes.add`), so the one card is nexnotes' (V20). The partners' marks are the module's (V21). Since 0.1.8 the
 * module's pages bring their own frame (`PAGE_FRAME`, B5): nexlore puts nothing around them.
 */
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import { ConnectionsArea, ConnectionsOperatorCard, ConsentPage, ReturnPage } from '../vendor/nexverbinden'
import { useAuth } from '../state/auth'
import { connectRequest, leave } from './request'

/** Mein Konto › Verbindungen, place 3: the cards of the other nex apps in use. */
export function AppsArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  return (
    <ConnectionsArea
      app="nexlore"
      operator={me?.role === 'operator'}
      request={connectRequest}
      areaWord={t('apiTokens.spaces')}
      language={i18n.language}
      navigate={(address) => leave.to(address)}
    />
  )
}

/** Server › Verbindungen (E67): the switch, the addresses and the suggestions of other nex apps (verbinden 0.2.0). */
export function AppsOperator() {
  const { i18n } = useTranslation()
  return <ConnectionsOperatorCard app="nexlore" request={connectRequest} language={i18n.language} />
}

/** `/connect/app`: another nex app asks to connect with nexlore. */
export function ConnectConsent() {
  const { t, i18n } = useTranslation()
  const { search } = useLocation()
  return <ConsentPage request={connectRequest} app="nexlore" search={search} areaWord={t('apiTokens.spaces')} language={i18n.language} navigate={(address) => leave.to(address)} />
}

/** `/connect/return`: back from the consent of the other app. */
export function ConnectReturn() {
  const { i18n } = useTranslation()
  const { search } = useLocation()
  return <ReturnPage app="nexlore" request={connectRequest} search={search} language={i18n.language} navigate={(address) => leave.to(address)} />
}
