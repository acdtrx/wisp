import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

import Login from './pages/Login';
import AppLayout from './components/layout/AppLayout';
import ProtectedRoute from './components/shared/ProtectedRoute';
import HostPanel from './components/host/HostPanel.jsx';
import VmRoute from './components/vm/VmRoute.jsx';
import ContainerRoute from './components/container/ContainerRoute.jsx';
import CreateVMPanel from './components/vm/CreateVMPanel.jsx';

const CreateContainerPanel = lazy(() => import('./components/container/CreateContainerPanel.jsx'));

function SuspenseFallback() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-text-muted" />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/host/overview" replace />} />
        <Route path="host" element={<Navigate to="/host/overview" replace />} />
        <Route path="host/:tab" element={<HostPanel />} />
        <Route path="vm/:name" element={<VmRoute />} />
        <Route path="vm/:name/:tab" element={<VmRoute />} />
        <Route path="container/:name" element={<ContainerRoute />} />
        <Route path="container/:name/:tab" element={<ContainerRoute />} />
        <Route path="create/vm" element={<CreateVMPanel />} />
        <Route
          path="create/container"
          element={
            <Suspense fallback={<SuspenseFallback />}>
              <CreateContainerPanel />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/host/overview" replace />} />
      </Route>
    </Routes>
  );
}
