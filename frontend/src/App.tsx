import { Navigate, Route, Routes } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { FilePage } from './pages/FilePage'
import { FilesPage } from './pages/FilesPage'
import { GraphPage } from './pages/GraphPage'
import { NotePage } from './pages/NotePage'
import { SettingsPage } from './pages/SettingsPage'

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<GraphPage />} />
        <Route path="note" element={<NotePage />} />
        <Route path="note/*" element={<NotePage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="file/*" element={<FilePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
