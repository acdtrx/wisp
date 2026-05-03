import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, Check, X, Network } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableBodyRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
  dataTableEmptyCellClass,
  rowActionIconBtnPrimary,
} from '../shared/DataTableChrome.jsx';
import {
  listManagedNetworkBridges,
  createManagedNetworkBridge,
  deleteManagedNetworkBridge,
} from '../../api/host.js';

const iconBtn = 'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

export default function HostNetworkBridges({ onError }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingName, setDeletingName] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [managed, setManaged] = useState([]);
  const [eligibleParents, setEligibleParents] = useState([]);
  const [baseBridge, setBaseBridge] = useState('');
  const [vlanId, setVlanId] = useState('');

  const reportError = useCallback((value) => {
    if (typeof onError === 'function') onError(value);
  }, [onError]);

  const refresh = useCallback(async () => {
    setLoading(true);
    reportError(null);
    try {
      const data = await listManagedNetworkBridges();
      const parents = Array.isArray(data.eligibleParents) ? data.eligibleParents : [];
      setManaged(Array.isArray(data.managed) ? data.managed : []);
      setEligibleParents(parents);
      if (parents.length > 0 && !parents.includes(baseBridge)) {
        setBaseBridge(parents[0]);
      }
    } catch (err) {
      reportError(err.detail || err.message || 'Failed to load network bridges');
    } finally {
      setLoading(false);
    }
  }, [baseBridge, reportError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const bridgePreview = useMemo(() => {
    const n = Number(vlanId);
    if (!baseBridge || !Number.isInteger(n) || n < 1 || n > 4094) return null;
    return `${baseBridge}-vlan${n}`;
  }, [baseBridge, vlanId]);

  const canCreate = !!bridgePreview && !submitting && eligibleParents.length > 0;

  const onCreate = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    reportError(null);
    try {
      await createManagedNetworkBridge(baseBridge, Number(vlanId));
      setVlanId('');
      setShowCreate(false);
      await refresh();
    } catch (err) {
      reportError(err.detail || err.message || 'Failed to create bridge');
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (name) => {
    setDeletingName(name);
    reportError(null);
    try {
      await deleteManagedNetworkBridge(name);
      await refresh();
    } catch (err) {
      reportError(err.detail || err.message || `Failed to delete bridge ${name}`);
    } finally {
      setDeletingName(null);
    }
  };

  const openCreate = () => {
    setShowCreate(true);
    reportError(null);
  };

  const cancelCreate = () => {
    setShowCreate(false);
    setVlanId('');
    reportError(null);
  };

  const headerAdd = (
    <button
      type="button"
      onClick={openCreate}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Add VLAN bridge"
      aria-label="Add VLAN bridge"
    >
      <Plus size={14} aria-hidden />
      <Network size={14} aria-hidden />
    </button>
  );

  return (
    <SectionCard
      title="Network Bridges"
      titleIcon={<Network size={14} strokeWidth={2} />}
      helpText="Bridges are how VMs and containers connect to networks. Add one from the header, then edit it inline. The host handles VLAN tagging — guests connect untagged."
      headerAction={headerAdd}
    >
      <div className="space-y-4">
        {loading ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : (
          <DataTableScroll>
            <DataTable minWidthRem={42}>
              <thead>
                <tr className={dataTableHeadRowClass}>
                  <DataTableTh dense className="w-48">Name</DataTableTh>
                  <DataTableTh dense>Parent</DataTableTh>
                  <DataTableTh dense>VLAN Id</DataTableTh>
                  <DataTableTh dense>Status</DataTableTh>
                  <DataTableTh dense align="right">Actions</DataTableTh>
                </tr>
              </thead>
              <tbody>
                {managed.length === 0 && !showCreate && (
                  <tr className={dataTableBodyRowClass}>
                    <td colSpan={5} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                      No managed VLAN bridges yet.
                    </td>
                  </tr>
                )}
                {managed.map((item) => (
                  <tr key={item.name} className={dataTableInteractiveRowClass}>
                    <DataTableTd dense className="w-48 font-mono text-sm text-text-primary">{item.name}</DataTableTd>
                    <DataTableTd dense className="font-mono text-sm text-text-secondary">{item.baseBridge}</DataTableTd>
                    <DataTableTd dense className="tabular-nums text-sm text-text-secondary">{item.vlanId}</DataTableTd>
                    <DataTableTd dense className="text-sm text-text-secondary">{item.present ? 'present' : 'missing'}</DataTableTd>
                    <DataTableTd dense align="right">
                      <DataTableRowActions forceVisible={deletingName === item.name}>
                        <button
                          type="button"
                          onClick={() => onDelete(item.name)}
                          disabled={deletingName === item.name}
                          className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-red-50`}
                          title={`Delete ${item.name}`}
                          aria-label={`Delete bridge ${item.name}`}
                        >
                          {deletingName === item.name ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                        </button>
                      </DataTableRowActions>
                    </DataTableTd>
                  </tr>
                ))}
                {showCreate && (
                  <tr className={dataTableInteractiveRowClass}>
                    <DataTableTd dense className="w-48 font-mono text-sm text-text-primary">
                      {bridgePreview || '—'}
                    </DataTableTd>
                    <DataTableTd dense>
                      {eligibleParents.length === 0 ? (
                        <span className="text-xs text-text-muted">No parent</span>
                      ) : (
                        <select
                          value={baseBridge}
                          onChange={(e) => setBaseBridge(e.target.value)}
                          className="input-field h-8 w-28 text-xs"
                          aria-label="Parent bridge"
                        >
                          {eligibleParents.map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                      )}
                    </DataTableTd>
                    <DataTableTd dense>
                      <input
                        type="number"
                        min="1"
                        max="4094"
                        value={vlanId}
                        onChange={(e) => setVlanId(e.target.value)}
                        placeholder="10"
                        className="input-field h-8 w-20 text-xs"
                        aria-label="VLAN ID"
                      />
                    </DataTableTd>
                    <DataTableTd dense className="text-xs text-text-muted">new</DataTableTd>
                    <DataTableTd dense align="right">
                      <DataTableRowActions forceVisible>
                        <button
                          type="button"
                          onClick={onCreate}
                          disabled={!canCreate}
                          className={rowActionIconBtnPrimary}
                          title="Create bridge"
                          aria-label="Create bridge"
                        >
                          {submitting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
                        </button>
                        <button
                          type="button"
                          onClick={cancelCreate}
                          disabled={submitting}
                          className={iconBtn}
                          title="Cancel"
                          aria-label="Cancel create bridge"
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </DataTableRowActions>
                    </DataTableTd>
                  </tr>
                )}
              </tbody>
            </DataTable>
          </DataTableScroll>
        )}
      </div>
    </SectionCard>
  );
}
