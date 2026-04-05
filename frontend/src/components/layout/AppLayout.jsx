import { useEffect, lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import TopBar from './TopBar';
import LeftPanel from './LeftPanel';
import HostPanel from '../host/HostPanel.jsx';
import OverviewPanel from '../vm/OverviewPanel.jsx';
import CreateVMPanel from '../vm/CreateVMPanel.jsx';
import VMStatsBar from '../vm/VMStatsBar.jsx';
import { useUiStore } from '../../store/uiStore.js';
import { useVmStore } from '../../store/vmStore.js';
import { useContainerStore } from '../../store/containerStore.js';
import { useSettingsStore } from '../../store/settingsStore.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { fetchBackgroundJobs } from '../../api/backgroundJobs.js';

const ContainerOverviewPanel = lazy(() => import('../container/ContainerOverviewPanel.jsx'));
const ContainerStatsBar = lazy(() => import('../container/ContainerStatsBar.jsx'));
const CreateContainerPanel = lazy(() => import('../container/CreateContainerPanel.jsx'));

export default function AppLayout() {
  const centerView = useUiStore((s) => s.centerView);
  const selectedVM = useVmStore((s) => s.selectedVM);
  const deselectVM = useVmStore((s) => s.deselectVM);
  const selectedContainer = useContainerStore((s) => s.selectedContainer);
  const deselectContainer = useContainerStore((s) => s.deselectContainer);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const settings = useSettingsStore((s) => s.settings);

  const hasSelection = !!selectedVM || !!selectedContainer;

  useEffect(() => {
    if (!settings) {
      document.title = 'Wisp';
      return () => {
        document.title = 'Wisp';
      };
    }
    const serverName = settings.serverName ?? 'My Server';
    document.title = `${serverName} — Wisp`;
    return () => {
      document.title = 'Wisp';
    };
  }, [settings]);

  useEffect(() => {
    if (!hasSelection) return;
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      /* Modals mark content with data-wisp-modal-root; skip shell deselect so Escape only closes the overlay */
      if (document.querySelector('[data-wisp-modal-root]')) return;
      deselectVM();
      deselectContainer();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [hasSelection, deselectVM, deselectContainer]);

  useEffect(() => {
    /* Non-fatal: settings store tracks error; app shell still renders */
    loadSettings().catch(() => {});
  }, [loadSettings]);

  useEffect(() => {
    let cancelled = false;
    fetchBackgroundJobs()
      .then(({ jobs }) => {
        if (cancelled) return;
        const registerJob = useBackgroundJobsStore.getState().registerJob;
        for (const j of jobs) {
          registerJob({
            jobId: j.jobId,
            kind: j.kind,
            title: j.title,
            startedAt: j.createdAt,
          });
        }
      })
      .catch(() => {
        /* non-fatal: tray stays empty until next action */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <TopBar />

      <div className="flex flex-1 overflow-hidden">
        <LeftPanel />

        <main className="flex flex-1 flex-col overflow-hidden bg-surface">
          {centerView === 'host' ? (
            <HostPanel />
          ) : selectedVM ? (
            <>
              <OverviewPanel />
              <VMStatsBar />
            </>
          ) : selectedContainer ? (
            <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-text-muted" /></div>}>
              <ContainerOverviewPanel />
              <ContainerStatsBar />
            </Suspense>
          ) : centerView === 'create' ? (
            <CreateVMPanel />
          ) : centerView === 'create-container' ? (
            <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-text-muted" /></div>}>
              <CreateContainerPanel />
            </Suspense>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-text-secondary">Select a workload or create a new one</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
