import { useEffect, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useContainer, useContainerStore } from '../../store/containerStore.js';
import { useVmStore } from '../../store/vmStore.js';
import { hasOpenLayer } from '../../lib/layers.js';
import { useFollowRename } from '../../hooks/useFollowRename.js';

const ContainerOverviewPanel = lazy(() => import('./ContainerOverviewPanel.jsx'));
const ContainerStatsBar = lazy(() => import('./ContainerStatsBar.jsx'));

export default function ContainerRoute() {
  const { name } = useParams();
  const navigate = useNavigate();
  const decodedName = name ? decodeURIComponent(name) : '';

  const selectContainer = useContainerStore((s) => s.select);
  const deselectContainer = useContainerStore((s) => s.deselect);
  const deselectVM = useVmStore((s) => s.deselect);

  /* The page's workload: its record, and while it exists its stats stream (selected). */
  const { record } = useContainer(decodedName);
  const gone = record.status === 'gone';
  useEffect(() => {
    if (!decodedName || gone) return;
    deselectVM();
    selectContainer(decodedName);
    return () => {
      deselectContainer();
    };
  }, [decodedName, gone, selectContainer, deselectContainer, deselectVM]);

  /* A rename made elsewhere: the gone page follows the container's uuid to its new name. */
  useFollowRename('container', decodedName, record, useContainerStore((s) => s.data));

  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (hasOpenLayer()) return; // the layer stack closes the top layer instead
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
      fallback={<Loading />}
    >
      <ContainerOverviewPanel name={decodedName} />
      <ContainerStatsBar name={decodedName} />
    </Suspense>
  );
}

/** The body while the page loads. */
function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-text-muted" />
    </div>
  );
}
