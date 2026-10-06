import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { AuthFrame } from './components/AuthFrame'
import { SecondFactor } from './components/SecondFactor'
import { AccountPage } from './pages/AccountPage'
import { CalendarPage } from './pages/CalendarPage'
import { CleanupPage } from './pages/CleanupPage'
import { AboutPage } from './pages/AboutPage'
import { ConnectPage } from './pages/ConnectPage'
import { McpRequestsPage } from './pages/McpRequestsPage'
import { CaptureRoute } from './pages/CaptureRoute'
import { FilePage } from './pages/FilePage'
import { FilesPage } from './pages/FilesPage'
import { GraphPage } from './pages/GraphPage'
import { ConfirmEmailPage } from './pages/ConfirmEmailPage'
import { InvitePage } from './pages/InvitePage'
import { LoginPage } from './pages/LoginPage'
import { NotePage } from './pages/NotePage'
import { PublicPage } from './pages/PublicPage'
import { SettingsPage } from './pages/SettingsPage'
import { SetupPage } from './pages/SetupPage'
import { TasksPage } from './pages/TasksPage'
import { LorePage } from './pages/LorePage'
import { SearchPage } from './pages/SearchPage'
import { useAuth } from './state/auth'
import { StoreProvider } from './state/store'

/** The app itself only for a signed-in account; everybody else goes to the sign-in, and back here afterwards. */
function SignedIn({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { status, me } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <p className="p-6 text-sm text-mist-500">{t('common.loading')}</p>
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') {
    const here = location.pathname + location.search
    return <Navigate to={here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`} replace />
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
      <button type="button" onClick={() => void signOut()} className="mt-5 w-full text-center text-xs text-mist-500 hover:text-mist-300">
        {t('account.signOut')}
      </button>
    </AuthFrame>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="setup" element={<SetupPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route path="confirm-email/:token" element={<ConfirmEmailPage />} />
      <Route path="s/:token/*" element={<PublicPage />} />
      {/* A connector signing in for MCP (block Y): the account first, then this page, without the app around it. */}
      <Route
        path="oauth/authorize"
        element={
          <SignedIn>
            <ConnectPage />
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
        <Route path="account" element={<AccountPage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="requests" element={<McpRequestsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
