import { useNavigate } from 'react-router-dom';
import { Play, Square, RotateCcw } from 'lucide-react';

import { useVmStore } from '../../store/vmStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { getVmIcon, getDefaultIconId } from '../shared/vmIcons.jsx';
import { formatMemory } from '../../utils/formatters.js';
import SectionPickerButton from '../sidebar/SectionPickerButton.jsx';
import IconButton from '../shared/IconButton.jsx';

/** Icon color by VM state (matches OverviewPanel title bar). */
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

export default function VMListItem({ vm }) {
  const selectedVM = useVmStore((s) => s.selected);
  const startVM = useVmStore((s) => s.startVM);
  const stopVM = useVmStore((s) => s.stopVM);
  const rebootVM = useVmStore((s) => s.rebootVM);
  const actionLoading = useVmStore((s) => s.actions[vm.name] ?? null);
  const organizeMode = useUiStore((s) => s.organizeMode);
  const navigate = useNavigate();

  const isSelected = selectedVM === vm.name;
  const isRunning = vm.state === 'running' || vm.state === 'blocked';
  const isStopped = vm.state === 'shutoff' || vm.state === 'nostate';
  const isPaused = vm.state === 'paused' || vm.state === 'pmsuspended';

  const iconId = vm.iconId || getDefaultIconId(vm.profile);
  const OsIcon = getVmIcon(iconId).component;
  const iconColorClass = STATE_ICON_COLOR[vm.state] || STATE_ICON_COLOR.nostate;
  const staleBinary = !!vm.staleBinary;
  const pendingRestart = !!vm.pendingRestart;

  const handleDragStart = (e) => {
    if (!organizeMode) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-wisp-workload', JSON.stringify({ type: 'vm', name: vm.name }));
  };

  return (
    <div
      onClick={() => { if (!organizeMode) navigate(`/vm/${encodeURIComponent(vm.name)}/overview`); }}
      draggable={organizeMode}
      onDragStart={handleDragStart}
      className={`group flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 ${
        organizeMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${
        isSelected && !organizeMode
          ? 'bg-surface-card border-l-2 border-l-accent'
          : 'hover:bg-surface-card'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <OsIcon size={14} className={`shrink-0 ${iconColorClass} ${isRunning ? 'wisp-lit-glyph' : ''}`} />
          <span className="truncate text-sm font-medium text-text-primary">{vm.name}</span>
          {(staleBinary || pendingRestart) && (
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-status-warning"
              title={pendingRestart
                ? 'Restart required: saved changes apply on the next start'
                : 'Restart required: qemu binary was updated after this VM started'}
            />
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-text-muted">
          {vm.vcpus} vCPU / {formatMemory(vm.memoryMiB)}
        </p>
      </div>

      {organizeMode ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <SectionPickerButton type="vm" name={vm.name} />
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5 hoverable:lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 transition-opacity duration-150">
          {isStopped && (
            <IconButton
              icon={Play}
              label="Start"
              title="Start"
              variant="positive"
              size="sm"
              disabled={!!actionLoading}
              onClick={(e) => { e.stopPropagation(); startVM(vm.name); }}
            />
          )}
          {isRunning && (
            <IconButton
              icon={Square}
              label="Stop"
              title="Stop"
              variant="danger"
              size="sm"
              disabled={!!actionLoading}
              onClick={(e) => { e.stopPropagation(); stopVM(vm.name); }}
            />
          )}
          {(isRunning || isPaused) && (
            <IconButton
              icon={RotateCcw}
              label="Reboot"
              title={staleBinary ? 'Reboot (qemu binary updated since VM started)' : 'Reboot'}
              variant="plain"
              size="sm"
              disabled={!!actionLoading || isPaused}
              onClick={(e) => { e.stopPropagation(); rebootVM(vm.name); }}
              badge={staleBinary && <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-status-warning" />}
            />
          )}
        </div>
      )}
    </div>
  );
}
