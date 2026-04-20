import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Play, Square, Zap, RotateCcw, Pause, PlayCircle,
  Copy, Trash2, Loader2, Code2, X, Archive,
} from 'lucide-react';

import { useVmStore } from '../../store/vmStore.js';
import { getVmIcon, getDefaultIconId } from '../shared/vmIcons.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import { updateVM } from '../../api/vms.js';
import { getSettings } from '../../api/settings.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { JOB_KIND } from '../../api/jobProgress.js';
import { startBackup } from '../../api/backups.js';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import CloneDialog from './CloneDialog.jsx';
import XMLModal from './XMLModal.jsx';
import BackupModal from './BackupModal.jsx';
import GeneralSection from '../sections/GeneralSection.jsx';
import DisksSection from '../sections/DisksSection.jsx';
import USBSection from '../sections/USBSection.jsx';
import AdvancedSection from '../sections/AdvancedSection.jsx';
import VmNetworkInterfacesSection from '../sections/VmNetworkInterfacesSection.jsx';
import CloudInitSection from '../sections/CloudInitSection.jsx';
import SnapshotsSection from '../sections/SnapshotsSection.jsx';

const ConsolePanel = lazy(() => import('../console/ConsolePanel.jsx'));

function SectionSkeleton({ count = 3 }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="rounded-xl border border-surface-border bg-surface-card p-4 space-y-3 animate-pulse">
      <div className="h-4 w-32 rounded bg-surface" />
      <div className="space-y-2">
        <div className="h-3 w-full rounded bg-surface" />
        <div className="h-3 w-2/3 rounded bg-surface" />
      </div>
    </div>
  ));
}

/** Icon color by VM state (used on the VM icon in the title bar). */
const STATE_ICON_COLOR = {
  running: 'text-status-running',
  blocked: 'text-status-running',
  paused: 'text-status-warning',
  pmsuspended: 'text-status-warning',
  shutdown: 'text-status-transition',
  shutoff: 'text-text-secondary',
  crashed: 'text-status-stopped',
  nostate: 'text-text-secondary',
};

function ActionButton({ icon: Icon, label, onClick, disabled, variant = 'default', loading, hint, badge }) {
  const base = 'relative flex items-center justify-center rounded-md p-2 text-sm font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    default: 'border border-surface-border text-text-secondary hover:bg-surface hover:text-text-primary',
    danger: 'border border-red-200 text-status-stopped hover:bg-red-50',
    primary: 'bg-accent text-white hover:bg-accent-hover',
  };
  const tip = hint ?? label;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      title={tip}
      aria-label={tip}
      className={`${base} ${variants[variant]}`}
    >
      {loading ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
      {badge && (
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500" />
      )}
    </button>
  );
}

export default function OverviewPanel() {
  const vmConfig = useVmStore((s) => s.vmConfig);
  const vmStats = useVmStore((s) => s.vmStats);
  const configLoading = useVmStore((s) => s.configLoading);
  const actionLoading = useVmStore((s) => s.actionLoading);
  const error = useVmStore((s) => s.error);
  const clearError = useVmStore((s) => s.clearError);
  const startVM = useVmStore((s) => s.startVM);
  const stopVM = useVmStore((s) => s.stopVM);
  const forceStopVM = useVmStore((s) => s.forceStopVM);
  const rebootVM = useVmStore((s) => s.rebootVM);
  const suspendVM = useVmStore((s) => s.suspendVM);
  const resumeVM = useVmStore((s) => s.resumeVM);
  const cloneVM = useVmStore((s) => s.cloneVM);
  const deleteVM = useVmStore((s) => s.deleteVM);
  const refreshSelectedVM = useVmStore((s) => s.refreshSelectedVM);
  const registerJob = useBackgroundJobsStore((s) => s.registerJob);
  const bgJobs = useBackgroundJobsStore((s) => s.jobs);

  const vmName = vmConfig?.name ?? '';
  const backupTitleForVm = useMemo(() => (vmName ? `Backup ${vmName}` : ''), [vmName]);
  const backupRunningJob = useMemo(
    () =>
      backupTitleForVm
        ? Object.values(bgJobs).find(
            (j) =>
              j.kind === JOB_KIND.BACKUP &&
              j.title === backupTitleForVm &&
              j.status === 'running',
          )
        : undefined,
    [bgJobs, backupTitleForVm],
  );
  const backupInProgress = !!backupRunningJob;

  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab === 'console' ? 'console' : 'overview';

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteDisks, setDeleteDisks] = useState(true);
  const [xmlModalOpen, setXmlModalOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [backupDestinations, setBackupDestinations] = useState([]);
  const [backupSelectedIds, setBackupSelectedIds] = useState(['local']);
  const [backupJobId, setBackupJobId] = useState(null);
  const [backupError, setBackupError] = useState(null);

  useEffect(() => {
    if (!backupJobId) return;
    const row = bgJobs[backupJobId];
    if (row && (row.status === 'done' || row.status === 'error')) {
      setBackupJobId(null);
    }
  }, [backupJobId, bgJobs]);

  useEffect(() => {
    setBackupJobId(null);
    setBackupError(null);
    setBackupModalOpen(false);
  }, [vmName]);

  if (!vmConfig) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-text-muted" />
      </div>
    );
  }

  const state = vmConfig.state;
  const isRunning = state === 'running' || state === 'blocked';
  const isStopped = state === 'shutoff' || state === 'nostate';
  const isPaused = state === 'paused' || state === 'pmsuspended';
  const iconColorClass = STATE_ICON_COLOR[state] || STATE_ICON_COLOR.nostate;
  const name = vmConfig.name;

  const handleClone = (newName) => {
    cloneVM(name, newName);
  };

  const handleDelete = () => {
    deleteVM(name, deleteDisks);
    setDeleteDialogOpen(false);
    // Do not reset deleteDisks here so the checkbox stays selected if delete fails and user retries
  };

  const handleOpenBackup = () => {
    setBackupModalOpen(true);
    setBackupError(null);
    const existing = Object.values(bgJobs).find(
      (j) =>
        j.kind === JOB_KIND.BACKUP &&
        j.title === backupTitleForVm &&
        j.status === 'running',
    );
    setBackupJobId(existing ? existing.jobId : null);
    setBackupSelectedIds(['local']);
    getSettings().then((s) => {
      const dests = [{ id: 'local', label: 'Local', path: s.backupLocalPath || '/var/lib/wisp/backups' }];
      if (s.backupMountId) {
        const m = (s.mounts || []).find((x) => x.id === s.backupMountId);
        const p = m && m.mountPath;
        if (m && p) dests.push({ id: m.id, label: m.label || 'Network', path: p });
      }
      setBackupDestinations(dests);
    }).catch(() => setBackupDestinations([{ id: 'local', label: 'Local', path: '/var/lib/wisp/backups' }]));
  };

  const handleSectionSave = async (changes) => {
    const result = await updateVM(name, changes);
    const newName =
      typeof changes.name === 'string' ? changes.name.trim() : '';
    const renamed = newName !== '' && newName !== name;
    await refreshSelectedVM(renamed ? newName : undefined);
    return result;
  };

  const iconId = vmConfig.iconId || getDefaultIconId(vmConfig.osCategory);
  const IconComp = getVmIcon(iconId).component;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header row: VM name + status | tabs | actions */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-4 border-b border-surface-border bg-surface-card px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => setIconPickerOpen(true)}
            className={`flex-shrink-0 rounded-lg p-1 transition-colors duration-150 hover:bg-surface hover:opacity-90 ${iconColorClass}`}
            title="Change icon"
          >
            <IconComp size={18} />
          </button>
          <span className="truncate text-sm font-semibold text-text-primary">{name}</span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-muted shrink-0">vm</span>
          <div className="flex border-l border-surface-border pl-3">
            <button
              type="button"
              onClick={() => navigate(`/vm/${encodeURIComponent(name)}/overview`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'overview' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => navigate(`/vm/${encodeURIComponent(name)}/console`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'console' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Console
            </button>
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
          <ActionButton
            icon={Play} label="Start"
            onClick={() => startVM(name)}
            disabled={!isStopped || backupInProgress}
            hint={backupInProgress ? 'Cannot start while a backup is in progress' : undefined}
            loading={actionLoading === 'start'}
            variant="primary"
          />
          <ActionButton
            icon={Square} label="Stop"
            onClick={() => stopVM(name)}
            disabled={isStopped}
            loading={actionLoading === 'stop'}
          />
          <ActionButton
            icon={Zap} label="Force Stop"
            onClick={() => forceStopVM(name)}
            disabled={isStopped}
            loading={actionLoading === 'force-stop'}
            variant="danger"
          />
          <ActionButton
            icon={RotateCcw} label="Reboot"
            onClick={() => rebootVM(name)}
            disabled={!isRunning}
            loading={actionLoading === 'reboot'}
            badge={!!vmStats?.staleBinary}
            hint={vmStats?.staleBinary ? 'Reboot (qemu binary updated since VM started)' : undefined}
          />
          <ActionButton
            icon={Pause} label="Suspend"
            onClick={() => suspendVM(name)}
            disabled={!isRunning}
            loading={actionLoading === 'suspend'}
          />
          <ActionButton
            icon={PlayCircle} label="Resume"
            onClick={() => resumeVM(name)}
            disabled={!isPaused}
            loading={actionLoading === 'resume'}
          />
          <div className="mx-0.5 h-4 w-px bg-surface-border" />
          <ActionButton
            icon={Archive} label="Backup"
            onClick={handleOpenBackup}
            disabled={!isStopped}
          />
          <CloneDialog
            trigger={(onOpen) => (
              <ActionButton icon={Copy} label="Clone" onClick={onOpen} disabled={isRunning} loading={actionLoading === 'clone'} />
            )}
            onConfirm={handleClone}
          />
          <ActionButton
            icon={Trash2} label="Delete"
            onClick={() => setDeleteDialogOpen(true)}
            variant="danger"
            loading={actionLoading === 'delete'}
          />
          <ActionButton
            icon={Code2} label="View XML"
            onClick={() => setXmlModalOpen(true)}
          />
        </div>
      </div>

      {/* Error display - visible in both tabs */}
      {error && (
        <div className="flex-shrink-0 flex items-center justify-between gap-2 rounded-none border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-status-stopped">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 rounded p-1 hover:bg-red-100 transition-colors duration-150"
            title="Dismiss"
            aria-label="Dismiss error"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {activeTab === 'console' ? (
        <Suspense fallback={
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        }>
          <ConsolePanel vmName={name} />
        </Suspense>
      ) : (
      /* Overview content */
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {/* Sections */}
        <GeneralSection
          vmConfig={vmConfig}
          isCreating={false}
          onSave={handleSectionSave}
        />

        {configLoading ? (
          <SectionSkeleton count={4} />
        ) : (
          <>
            <DisksSection
              vmConfig={vmConfig}
              onRefresh={refreshSelectedVM}
            />

            <USBSection vmConfig={vmConfig} />

            <VmNetworkInterfacesSection
              vmConfig={vmConfig}
              isCreating={false}
              onSave={handleSectionSave}
            />

            <AdvancedSection
              vmConfig={vmConfig}
              isCreating={false}
              onSave={handleSectionSave}
            />

            {vmConfig.osCategory !== 'windows' && (
              <CloudInitSection
                vmConfig={vmConfig}
                isCreating={false}
                onRefresh={refreshSelectedVM}
              />
            )}

            <SnapshotsSection vmConfig={vmConfig} />
          </>
        )}
      </div>
      )}

      {/* Delete dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete VM"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => { setDeleteDialogOpen(false); setDeleteDisks(true); }}
      >
        <p>Are you sure you want to delete &ldquo;{name}&rdquo;? This cannot be undone.</p>
        <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={deleteDisks}
            onChange={(e) => setDeleteDisks(e.target.checked)}
            className="rounded border-surface-border"
          />
          Also delete disk images
        </label>
      </ConfirmDialog>

      {/* XML modal */}
      <XMLModal
        open={xmlModalOpen}
        vmName={name}
        onClose={() => setXmlModalOpen(false)}
      />

      {/* Backup modal */}
      {backupModalOpen && (
        <BackupModal
          vmName={name}
          backupStarted={!!backupJobId}
          destinations={backupDestinations}
          selectedIds={backupSelectedIds}
          onToggleDestination={(id) => {
            setBackupSelectedIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
            );
          }}
          progress={
            backupJobId && bgJobs[backupJobId]
              ? {
                  step: bgJobs[backupJobId].step || 'starting',
                  percent: bgJobs[backupJobId].percent,
                  currentFile: bgJobs[backupJobId].detail,
                }
              : null
          }
          error={
            backupJobId && bgJobs[backupJobId]?.status === 'error'
              ? bgJobs[backupJobId].error
              : backupError
          }
          onStart={async () => {
            setBackupError(null);
            try {
              const { jobId, title } = await startBackup(name, { destinationIds: backupSelectedIds });
              setBackupJobId(jobId);
              registerJob({
                jobId,
                kind: JOB_KIND.BACKUP,
                title,
              });
            } catch (err) {
              setBackupError(err.message || 'Failed to start backup');
              setBackupJobId(null);
            }
          }}
          onClose={() => {
            setBackupModalOpen(false);
            const row = backupJobId ? bgJobs[backupJobId] : null;
            if (!row || row.status !== 'running') {
              setBackupJobId(null);
              setBackupError(null);
            }
          }}
        />
      )}

      {/* Icon picker */}
      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={vmConfig.iconId || getDefaultIconId(vmConfig.osCategory)}
        onSelect={async (selectedIconId) => {
          await updateVM(name, { iconId: selectedIconId });
          await refreshSelectedVM();
        }}
        onClose={() => setIconPickerOpen(false)}
      />
    </div>
  );
}
