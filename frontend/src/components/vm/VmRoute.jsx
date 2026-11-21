import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useParams, useNavigate } from 'react-router-dom';
import OverviewPanel from './OverviewPanel.jsx';
import VMStatsBar from './VMStatsBar.jsx';
import { useVm, useVmStore } from '../../store/vmStore.js';
import { useContainerStore } from '../../store/containerStore.js';
import { hasOpenLayer } from '../../lib/layers.js';
import { UNKNOWN, renameStep } from '../../store/renameFollow.js';

export default function VmRoute() {
  const { name, tab } = useParams();
  const navigate = useNavigate();
  const decodedName = name ? decodeURIComponent(name) : '';

  const selectVM = useVmStore((s) => s.select);
  const deselectVM = useVmStore((s) => s.deselect);
  const deselectContainer = useContainerStore((s) => s.deselect);

  /* The page's workload: its record, and while it exists its stats stream (selected). */
  const { record } = useVm(decodedName);
  const gone = record.status === 'gone';
  useEffect(() => {
    if (!decodedName || gone) return;
    deselectContainer();
    selectVM(decodedName);
    return () => {
      deselectVM();
    };
  }, [decodedName, gone, selectVM, deselectVM, deselectContainer]);

  /* The open VM renamed elsewhere: the list no longer lists this name, but lists the
   * VM's uuid under another — the last uuid its config record had for this name, kept
   * past a 404 for it — in a frame newer than that uuid (store/renameFollow.js). The URL
   * follows, so a refresh opens it again; this runs only while this page shows the old
   * name. */
  const [known, setKnown] = useState(UNKNOWN);
  const list = useVmStore((s) => s.data);
  const step = renameStep(known, { name: decodedName, recordUuid: record.data?.uuid ?? null, list });
  if (step.known !== known) setKnown(step.known);
  const newName = step.renamedTo;
  useEffect(() => {
    if (!newName) return;
    useVmStore.getState().followRename(decodedName, newName);
    const tabPart = tab ? `/${tab}` : '';
    navigate(`/vm/${encodeURIComponent(newName)}${tabPart}`, { replace: true });
  }, [newName, decodedName, tab, navigate]);

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

  /* Following a rename, the old name's page is not shown again (its record may already
   * be gone): the new name's page loads in its place. */
  if (newName) return <Following />;

  return (
    <>
      <OverviewPanel name={decodedName} />
      <VMStatsBar name={decodedName} />
    </>
  );
}

/** The body while the page follows a rename. */
function Following() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-text-muted" />
    </div>
  );
}
