import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { AuthFrame } from './components/AuthFrame'
import { SecondFactor } from './pages/settings/SecondFactorBoxes'
import { CalendarPage } from './pages/CalendarPage'
import { CleanupPage } from './pages/CleanupPage'
import { AppConnectPage } from './pages/AppConnectPage'
import { ConnectConsent, ConnectReturn } from './connect/connect'
import { McpConsentPage, McpRequestRoute } from './pages/McpPages'
import { McpRequestsPage } from './pages/McpRequestsPage'
import { CaptureRoute } from './pages/CaptureRoute'
import { FilePage } from './pages/FilePage'
import { FilesPage } from './pages/FilesPage'
import { GraphPage } from './pages/GraphPage'
import { EmailPage, ForgotPage, InvitePage, LoginPage, ResetPage, SetupPage } from './pages/AuthPages'
import { NotePage } from './pages/NotePage'
import { PublicPage } from './pages/PublicPage'
import { FormerAboutAddress, FormerAccountAddress, SettingsPage } from './pages/SettingsPage'
import { TasksPage } from './pages/TasksPage'
import { LorePage } from './pages/LorePage'
import { SearchPage } from './pages/SearchPage'
import { useAuth } from './state/auth'
import { signedOutHere } from './api/client'
import { StoreProvider } from './state/store'
import { TextLink } from './vendor/nexui'

/** The app itself only for a signed-in account; everybody else goes to the sign-in, and back here afterwards. */
function SignedIn({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { status, me } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <p className="p-6 text-sm text-mist-500">{t('common.loading')}</p>
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') {
    const here = location.pathname + location.search
    return <Navigate to={here === '/' || signedOutHere() ? '/login' : `/login?next=${encodeURIComponent(here)}`} replace />
  }
  if (status === 'error') return <p className="p-6 text-sm text-bad-500">{t('errors.byCode.internal_error')}</p>
  if (me?.second_factor_setup_required) return <SecondFactorFirst />
  return <StoreProvider>{children}</StoreProvider>
}

/**
 * The operator requires a second factor and this account has none yet. The server answers everything else with 403,
 * so nothing else is offered: setting it up, or signing out.
 */
function SecondFactorFirst() {
  const { t } = useTranslation()
  const { me, signOut } = useAuth()
  return (
    <AuthFrame title={t('twofactor.requiredTitle')} text={t('twofactor.requiredText')}>
      {me && <SecondFactor me={me} />}
      <div className="text-center">
        <TextLink onClick={() => void signOut()}>{t('me.signOut')}</TextLink>
      </div>
    </AuthFrame>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="setup" element={<SetupPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route path="forgot" element={<ForgotPage />} />
      <Route path="reset/:token" element={<ResetPage />} />
      <Route path="email/:token" element={<EmailPage />} />
      {/* The confirmation links 1.16.0 mailed: the same page. */}
      <Route path="confirm-email/:token" element={<EmailPage />} />
      <Route path="s/:token/*" element={<PublicPage />} />
      {/* A connector signing in for MCP (block Y, the shared module mcp 1.1.0): the account first, then this page,
          without the app around it. */}
      <Route
        path="oauth/authorize"
        element={
          <SignedIn>
            <McpConsentPage />
          </SignedIn>
        }
      />
      {/* Another nex app connecting with nexlore (the shared module verbinden): the consent, then the way back from
          the other app's consent; the account first, without the app around it. */}
      <Route
        path="connect/app"
        element={
          <SignedIn>
            <ConnectConsent />
          </SignedIn>
        }
      />
      <Route
        path="connect/return"
        element={
          <SignedIn>
            <ConnectReturn />
          </SignedIn>
        }
      />
      {/* The iPhone app connecting by address: sign in as always, then confirm, without the app around it. */}
      <Route
        path="app-connect"
        element={
          <SignedIn>
            <AppConnectPage />
          </SignedIn>
        }
      />
      <Route
        element={
          <SignedIn>
            <AppShell />
          </SignedIn>
        }
      >
        <Route index element={<GraphPage />} />
        <Route path="note" element={<NotePage />} />
        <Route path="note/*" element={<NotePage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="lore" element={<LorePage />} />
        <Route path="lore/:id" element={<LorePage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="files/cleanup" element={<CleanupPage />} />
        <Route path="capture" element={<CaptureRoute />} />
        <Route path="file/*" element={<FilePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/:area" element={<SettingsPage />} />
        {/* The addresses of before: the server still sends people to /account and /about. */}
        <Route path="account" element={<FormerAccountAddress />} />
        <Route path="about" element={<FormerAboutAddress />} />
        <Route path="requests" element={<McpRequestsPage />} />
        {/* One waiting request of an AI program, the page of the shared module mcp 1.1.0. */}
        <Route path="mcp/requests/:id" element={<McpRequestRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
