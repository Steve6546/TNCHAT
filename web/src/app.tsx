import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/layout/app-shell';
import { LoginPage } from './features/auth/login-page';
import { ChannelsPage } from './features/channels/channels-page';
import { KeysPage } from './features/keys/keys-page';
import { OverviewPage } from './features/overview/overview-page';
import { SettingsPage } from './features/settings/settings-page';
import { useAuthStore } from './stores/auth-store';

function ProtectedShell() {
  const token = useAuthStore((state) => state.token);
  return token ? <AppShell /> : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="models" element={<ChannelsPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
