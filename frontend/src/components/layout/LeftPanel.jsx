import { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plus, Monitor, Search, Server, Box } from 'lucide-react';
import { useVmStore } from '../../store/vmStore.js';
import { useContainerStore } from '../../store/containerStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { useSettingsStore } from '../../store/settingsStore.js';
import { useStatsStore } from '../../store/statsStore.js';
import { formatMemory } from '../../utils/formatters.js';
import VMListItem from '../vm/VMListItem.jsx';
import ContainerListItem from '../container/ContainerListItem.jsx';

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'vms', label: 'VMs' },
  { value: 'containers', label: 'Containers' },
];

export default function LeftPanel() {
  const vms = useVmStore((s) => s.vms);
  const startVMListSSE = useVmStore((s) => s.startVMListSSE);
  const stopVMListSSE = useVmStore((s) => s.stopVMListSSE);
  const containers = useContainerStore((s) => s.containers);
  const startContainerListSSE = useContainerStore((s) => s.startContainerListSSE);
  const stopContainerListSSE = useContainerStore((s) => s.stopContainerListSSE);
  const listFilter = useUiStore((s) => s.listFilter);
  const setListFilter = useUiStore((s) => s.setListFilter);
  const navigate = useNavigate();
  const location = useLocation();
  const refreshIntervalSeconds = useSettingsStore((s) => s.settings?.refreshIntervalSeconds ?? 5);
  const stats = useStatsStore((s) => s.stats);
  const pendingUpdates = stats?.pendingUpdates ?? 0;

  const [search, setSearch] = useState('');
  const [sortRunningFirst, setSortRunningFirst] = useState(false);

  const intervalMs = refreshIntervalSeconds * 1000;

  useEffect(() => {
    startVMListSSE(intervalMs);
    startContainerListSSE(intervalMs);
    return () => {
      stopVMListSSE();
      stopContainerListSSE();
    };
  }, [startVMListSSE, stopVMListSSE, startContainerListSSE, stopContainerListSSE, intervalMs]);

  const allItems = useMemo(() => {
    const vmItems = (listFilter === 'all' || listFilter === 'vms')
      ? vms.map((v) => ({ ...v, _type: 'vm' }))
      : [];
    const ctItems = (listFilter === 'all' || listFilter === 'containers')
      ? containers.map((c) => ({ ...c, _type: 'container' }))
      : [];

    let list = [...vmItems, ...ctItems];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((item) => item.name.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      if (sortRunningFirst) {
        const aRunning = a.state === 'running' || a.state === 'blocked' ? 0 : 1;
        const bRunning = b.state === 'running' || b.state === 'blocked' ? 0 : 1;
        if (aRunning !== bRunning) return aRunning - bRunning;
      }
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [vms, containers, search, sortRunningFirst, listFilter]);

  const totalCount = vms.length + containers.length;
  const isHostSelected = location.pathname === '/' || location.pathname.startsWith('/host');

  const openHost = () => navigate('/host/overview');

  return (
    <aside className="flex w-[280px] flex-col border-r border-surface-border bg-surface-sidebar">
      <button
        type="button"
        onClick={openHost}
        className={`flex h-11 w-full items-center gap-3 px-4 text-left transition-colors duration-150 border-b border-surface-border ${
          isHostSelected ? 'bg-surface-card border-l-2 border-l-accent' : 'hover:bg-surface-card'
        }`}
      >
        <Server size={18} className="flex-shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium text-text-primary">Host</span>
          {stats?.cpu?.total != null && stats?.memory?.totalGB != null && (
            <p className="text-[11px] text-text-muted">
              {stats.cpu.total} CPU / {formatMemory(Math.round(stats.memory.totalGB * 1024))}
            </p>
          )}
        </div>
        {pendingUpdates > 0 && (
          <span className="flex h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" title={`${pendingUpdates} update(s) available`} />
        )}
      </button>

      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Workloads
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate('/create/vm')}
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150"
            title="New VM"
          >
            <Plus size={14} />
            <Server size={12} />
          </button>
          <button
            onClick={() => navigate('/create/container')}
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150"
            title="New Container"
          >
            <Plus size={14} />
            <Box size={12} />
          </button>
        </div>
      </div>

      {totalCount > 0 && (
        <div className="px-3 pt-3 pb-1 space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full rounded-md border border-surface-border bg-surface-card pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent transition-colors duration-150"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex rounded-md border border-surface-border bg-surface p-0.5">
              {FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setListFilter(opt.value)}
                  className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors duration-150 ${
                    listFilter === opt.value
                      ? 'bg-surface-card text-text-primary shadow-sm'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setSortRunningFirst(!sortRunningFirst)}
              className={`text-[10px] font-medium transition-colors duration-150 ${
                sortRunningFirst ? 'text-accent' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {sortRunningFirst ? '● Running first' : '○ Alphabetical'}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {allItems.length > 0 ? (
          <div className="space-y-0">
            {allItems.map((item) =>
              item._type === 'vm' ? (
                <VMListItem key={`vm-${item.name}`} vm={item} />
              ) : (
                <ContainerListItem key={`ct-${item.name}`} container={item} />
              ),
            )}
          </div>
        ) : totalCount > 0 && search.trim() ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Search size={24} className="text-text-muted mb-2" />
            <p className="text-xs text-text-muted">No matches for &ldquo;{search}&rdquo;</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Monitor size={32} className="text-text-muted mb-2" />
            <p className="text-sm text-text-muted">No workloads</p>
            <p className="text-xs text-text-muted mt-1">Create a VM or container to get started</p>
          </div>
        )}
      </div>
    </aside>
  );
}
