import { useNavigate } from 'react-router-dom';
import { Play, Square, RotateCcw } from 'lucide-react';
import { useContainerStore } from '../../store/containerStore.js';
import { CONTAINER_STATE_ICON_COLOR } from '../../utils/containerConstants.js';
import { getVmIcon, getDefaultContainerIconId } from '../shared/vmIcons.jsx';

function shortImage(image) {
  if (!image) return '';
  let short = image.replace(/^docker\.io\/library\//, '').replace(/^docker\.io\//, '');
  if (short.length > 30) short = short.slice(0, 27) + '…';
  return short;
}

export default function ContainerListItem({ container }) {
  const selectedContainer = useContainerStore((s) => s.selectedContainer);
  const startContainer = useContainerStore((s) => s.startContainer);
  const stopContainer = useContainerStore((s) => s.stopContainer);
  const restartContainer = useContainerStore((s) => s.restartContainer);
  const actionLoading = useContainerStore((s) => s.actionLoading);
  const navigate = useNavigate();

  const isSelected = selectedContainer === container.name;
  const isRunning = container.state === 'running';
  const isStopped = container.state === 'stopped' || container.state === 'unknown';
  const iconColorClass = CONTAINER_STATE_ICON_COLOR[container.state] || CONTAINER_STATE_ICON_COLOR.unknown;
  const iconId = container.iconId || getDefaultContainerIconId();
  const WorkloadIcon = getVmIcon(iconId).component;

  const handleSelect = () => {
    navigate(`/container/${encodeURIComponent(container.name)}/overview`);
  };

  return (
    <div
      onClick={handleSelect}
      className={`group flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors duration-150 ${
        isSelected
          ? 'bg-surface-card border-l-2 border-l-accent'
          : 'hover:bg-surface-card'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <WorkloadIcon size={14} className={`shrink-0 ${iconColorClass}`} />
          <span className="truncate text-sm font-medium text-text-primary">{container.name}</span>
          {container.updateAvailable && (
            <span
              className="shrink-0 rounded-full bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-800"
              title="A new image version is available. Restart to apply."
            >
              Update
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-text-muted truncate">
          {shortImage(container.image)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        {isStopped && (
          <button
            onClick={(e) => { e.stopPropagation(); startContainer(container.name); }}
            disabled={!!actionLoading}
            className="rounded p-1 text-text-secondary hover:bg-green-50 hover:text-status-running disabled:opacity-40"
            title="Start"
          >
            <Play size={14} />
          </button>
        )}
        {isRunning && (
          <button
            onClick={(e) => { e.stopPropagation(); stopContainer(container.name); }}
            disabled={!!actionLoading}
            className="rounded p-1 text-text-secondary hover:bg-red-50 hover:text-status-stopped disabled:opacity-40"
            title="Stop"
          >
            <Square size={14} />
          </button>
        )}
        {isRunning && (
          <button
            onClick={(e) => { e.stopPropagation(); restartContainer(container.name); }}
            disabled={!!actionLoading}
            className="rounded p-1 text-text-secondary hover:bg-blue-50 hover:text-accent disabled:opacity-40"
            title="Restart"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
