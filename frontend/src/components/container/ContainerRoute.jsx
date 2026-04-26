import { useEffect, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useContainerStore } from '../../store/containerStore.js';
import { useVmStore } from '../../store/vmStore.js';

const ContainerOverviewPanel = lazy(() => import('./ContainerOverviewPanel.jsx'));
const ContainerStatsBar = lazy(() => import('./ContainerStatsBar.jsx'));

export default function ContainerRoute() {
  const { name } = useParams();
  const navigate = useNavigate();
  const decodedName = name ? decodeURIComponent(name) : '';

  const selectContainer = useContainerStore((s) => s.selectContainer);
  const deselectContainer = useContainerStore((s) => s.deselectContainer);
  const deselectVM = useVmStore((s) => s.deselectVM);

  useEffect(() => {
    if (!decodedName) return;
    deselectVM();
    selectContainer(decodedName);
    return () => {
      deselectContainer();
    };
  }, [decodedName, selectContainer, deselectContainer, deselectVM]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[data-wisp-modal-root]')) return;
      // Don't hijack Escape when the user is interacting with a form control — they're
      // likely trying to cancel an inline edit, not navigate away from the page.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      navigate('/host/overview');
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [navigate]);

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-text-muted" />
        </div>
      }
    >
      <ContainerOverviewPanel />
      <ContainerStatsBar />
    </Suspense>
  );
}
