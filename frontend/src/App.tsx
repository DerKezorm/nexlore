import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { AccountPage } from './pages/AccountPage'
import { FilePage } from './pages/FilePage'
import { FilesPage } from './pages/FilesPage'
import { GraphPage } from './pages/GraphPage'
import { InvitePage } from './pages/InvitePage'
import { LoginPage } from './pages/LoginPage'
import { NotePage } from './pages/NotePage'
import { PublicPage } from './pages/PublicPage'
import { SettingsPage } from './pages/SettingsPage'
import { SetupPage } from './pages/SetupPage'
import { useAuth } from './state/auth'
import { StoreProvider } from './state/store'

/** The app itself only for a signed-in account; everybody else goes to the sign-in, and back here afterwards. */
function SignedIn({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <p className="p-6 text-sm text-mist-500">{t('common.loading')}</p>
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') {
    const here = location.pathname + location.search
    return <Navigate to={here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`} replace />
  }
  if (status === 'error') return <p className="p-6 text-sm text-bad-500">{t('errors.byCode.internal_error')}</p>
  return <StoreProvider>{children}</StoreProvider>
}

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="setup" element={<SetupPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route path="s/:token/*" element={<PublicPage />} />
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
        <Route path="files" element={<FilesPage />} />
        <Route path="file/*" element={<FilePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
