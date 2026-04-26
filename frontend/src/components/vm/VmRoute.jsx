import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import OverviewPanel from './OverviewPanel.jsx';
import VMStatsBar from './VMStatsBar.jsx';
import { useVmStore } from '../../store/vmStore.js';
import { useContainerStore } from '../../store/containerStore.js';

export default function VmRoute() {
  const { name } = useParams();
  const navigate = useNavigate();
  const decodedName = name ? decodeURIComponent(name) : '';

  const selectVM = useVmStore((s) => s.selectVM);
  const deselectVM = useVmStore((s) => s.deselectVM);
  const deselectContainer = useContainerStore((s) => s.deselectContainer);

  useEffect(() => {
    if (!decodedName) return;
    deselectContainer();
    selectVM(decodedName);
    return () => {
      deselectVM();
    };
  }, [decodedName, selectVM, deselectVM, deselectContainer]);

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
    <>
      <OverviewPanel />
      <VMStatsBar />
    </>
  );
}
