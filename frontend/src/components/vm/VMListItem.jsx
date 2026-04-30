import { useNavigate } from 'react-router-dom';
import { Play, Square, RotateCcw } from 'lucide-react';
import { useVmStore } from '../../store/vmStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { getVmIcon, getDefaultIconId } from '../shared/vmIcons.jsx';
import { formatMemory } from '../../utils/formatters.js';
import SectionPickerButton from '../sidebar/SectionPickerButton.jsx';

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
  const selectedVM = useVmStore((s) => s.selectedVM);
  const startVM = useVmStore((s) => s.startVM);
  const stopVM = useVmStore((s) => s.stopVM);
  const rebootVM = useVmStore((s) => s.rebootVM);
  const actionLoading = useVmStore((s) => s.actionLoading);
  const organizeMode = useUiStore((s) => s.organizeMode);
  const navigate = useNavigate();

  const isSelected = selectedVM === vm.name;
  const isRunning = vm.state === 'running' || vm.state === 'blocked';
  const isStopped = vm.state === 'shutoff' || vm.state === 'nostate';
  const isPaused = vm.state === 'paused' || vm.state === 'pmsuspended';

  const iconId = vm.iconId || getDefaultIconId(vm.osCategory);
  const OsIcon = getVmIcon(iconId).component;
  const iconColorClass = STATE_ICON_COLOR[vm.state] || STATE_ICON_COLOR.nostate;
  const staleBinary = !!vm.staleBinary;

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
          <OsIcon size={14} className={`shrink-0 ${iconColorClass}`} />
          <span className="truncate text-sm font-medium text-text-primary">{vm.name}</span>
          {staleBinary && (
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500"
              title="Restart required: qemu binary was updated after this VM started"
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
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          {isStopped && (
            <button
              onClick={(e) => { e.stopPropagation(); startVM(vm.name); }}
              disabled={!!actionLoading}
              className="rounded p-1 text-text-secondary hover:bg-green-50 hover:text-status-running disabled:opacity-40"
              title="Start"
            >
              <Play size={14} />
            </button>
          )}
          {isRunning && (
            <button
              onClick={(e) => { e.stopPropagation(); stopVM(vm.name); }}
              disabled={!!actionLoading}
              className="rounded p-1 text-text-secondary hover:bg-red-50 hover:text-status-stopped disabled:opacity-40"
              title="Stop"
            >
              <Square size={14} />
            </button>
          )}
          {(isRunning || isPaused) && (
            <button
              onClick={(e) => { e.stopPropagation(); rebootVM(vm.name); }}
              disabled={!!actionLoading || isPaused}
              className="relative rounded p-1 text-text-secondary hover:bg-blue-50 hover:text-accent disabled:opacity-40"
              title={staleBinary ? 'Reboot (qemu binary updated since VM started)' : 'Reboot'}
            >
              <RotateCcw size={14} />
              {staleBinary && (
                <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
