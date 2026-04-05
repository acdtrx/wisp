import { useState } from 'react';
import {
  Play, Square, Zap, RotateCcw, Trash2, Loader2, X,
} from 'lucide-react';

import { useContainerStore } from '../../store/containerStore.js';
import { updateContainer } from '../../api/containers.js';
import { getVmIcon, getDefaultContainerIconId } from '../shared/vmIcons.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import ContainerGeneralSection from '../sections/ContainerGeneralSection.jsx';
import ContainerEnvSection from '../sections/ContainerEnvSection.jsx';
import ContainerMountsSection from '../sections/ContainerMountsSection.jsx';
import ContainerNetworkSection from '../sections/ContainerNetworkSection.jsx';
import ContainerLogsSection from '../sections/ContainerLogsSection.jsx';
import { CONTAINER_STATE_ICON_COLOR } from '../../utils/containerConstants.js';

function ActionButton({ icon: Icon, label, onClick, disabled, variant = 'default', loading }) {
  const base = 'flex items-center justify-center rounded-md p-2 text-sm font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    default: 'border border-surface-border text-text-secondary hover:bg-surface hover:text-text-primary',
    danger: 'border border-red-200 text-status-stopped hover:bg-red-50',
    primary: 'bg-accent text-white hover:bg-accent-hover',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      title={label}
      aria-label={label}
      className={`${base} ${variants[variant]}`}
    >
      {loading ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
    </button>
  );
}

export default function ContainerOverviewPanel() {
  const config = useContainerStore((s) => s.containerConfig);
  const loading = useContainerStore((s) => s.loading);
  const actionLoading = useContainerStore((s) => s.actionLoading);
  const error = useContainerStore((s) => s.error);
  const clearError = useContainerStore((s) => s.clearError);
  const startContainer = useContainerStore((s) => s.startContainer);
  const stopContainer = useContainerStore((s) => s.stopContainer);
  const killContainer = useContainerStore((s) => s.killContainer);
  const restartContainer = useContainerStore((s) => s.restartContainer);
  const deleteContainer = useContainerStore((s) => s.deleteContainer);
  const refreshSelectedContainer = useContainerStore((s) => s.refreshSelectedContainer);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  if (loading || !config) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-text-muted" />
      </div>
    );
  }

  const state = config.state;
  const isRunning = state === 'running';
  const isStopped = state === 'stopped' || state === 'unknown';
  const name = config.name;
  const iconColorClass = CONTAINER_STATE_ICON_COLOR[state] || CONTAINER_STATE_ICON_COLOR.unknown;
  const iconId = config.iconId || getDefaultContainerIconId();
  const IconComp = getVmIcon(iconId).component;

  const handleDelete = () => {
    deleteContainer(name, deleteFiles);
    setDeleteDialogOpen(false);
  };

  const handleSectionSave = async (changes) => {
    const result = await updateContainer(name, changes);
    await refreshSelectedContainer();
    return result;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-surface-border bg-surface-card px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setIconPickerOpen(true)}
            className={`flex-shrink-0 rounded-lg p-1 transition-colors duration-150 hover:bg-surface hover:opacity-90 ${iconColorClass}`}
            title="Change icon"
          >
            <IconComp size={18} />
          </button>
          <span className="truncate text-sm font-semibold text-text-primary">{name}</span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-muted shrink-0">container</span>
          <div className="flex border-l border-surface-border pl-3">
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'overview' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('logs')}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'logs' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Logs
            </button>
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
          <ActionButton icon={Play} label="Start" onClick={() => startContainer(name)} disabled={!isStopped} loading={actionLoading === 'start'} variant="primary" />
          <ActionButton icon={Square} label="Stop" onClick={() => stopContainer(name)} disabled={isStopped} loading={actionLoading === 'stop'} />
          <ActionButton icon={Zap} label="Kill" onClick={() => killContainer(name)} disabled={isStopped} loading={actionLoading === 'kill'} variant="danger" />
          <ActionButton icon={RotateCcw} label="Restart" onClick={() => restartContainer(name)} disabled={!isRunning} loading={actionLoading === 'restart'} />
          <div className="mx-0.5 h-4 w-px bg-surface-border" />
          <ActionButton icon={Trash2} label="Delete" onClick={() => setDeleteDialogOpen(true)} variant="danger" loading={actionLoading === 'delete'} />
        </div>
      </div>

      {error && (
        <div className="flex-shrink-0 flex items-center justify-between gap-2 rounded-none border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-status-stopped">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={clearError} className="shrink-0 rounded p-1 hover:bg-red-100 transition-colors duration-150" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {activeTab === 'logs' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ContainerLogsSection containerName={name} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <ContainerGeneralSection config={config} onSave={handleSectionSave} />
          <ContainerEnvSection config={config} onSave={handleSectionSave} />
          <ContainerMountsSection config={config} onRefresh={refreshSelectedContainer} />
          <ContainerNetworkSection config={config} onSave={handleSectionSave} />
        </div>
      )}

      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete Container"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => { setDeleteDialogOpen(false); setDeleteFiles(true); }}
      >
        <p>Are you sure you want to delete &ldquo;{name}&rdquo;? This cannot be undone.</p>
        <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="rounded border-surface-border" />
          Also delete uploaded files
        </label>
      </ConfirmDialog>

      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={config.iconId || getDefaultContainerIconId()}
        onSelect={async (selectedIconId) => {
          await updateContainer(name, { iconId: selectedIconId });
          await refreshSelectedContainer();
        }}
        onClose={() => setIconPickerOpen(false)}
      />
    </div>
  );
}
