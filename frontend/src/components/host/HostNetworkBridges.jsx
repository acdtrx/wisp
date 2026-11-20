import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Trash2, Network } from 'lucide-react';

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
  rowActionIconBtn,
} from '../shared/DataTableChrome.jsx';
import BridgeCreateModal from './BridgeCreateModal.jsx';
import { awaitJob } from '../../store/backgroundJobsStore.js';
import { useKindChanges } from '../../hooks/useChanges.js';
import {
  listManagedNetworkBridges,
  deleteManagedNetworkBridge,
} from '../../api/host.js';
import { errorText } from '../../api/errors.js';

export default function HostNetworkBridges({ onError }) {
  const [loading, setLoading] = useState(true);
  const [deletingName, setDeletingName] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [managed, setManaged] = useState([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [eligibleParents, setEligibleParents] = useState([]);

  const reportError = useCallback((value) => {
    if (typeof onError === 'function') onError(value);
  }, [onError]);

  /* Reads are numbered: only the newest one sent applies, or reports its failure. */
  const readsSent = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++readsSent.current;
    try {
      const data = await listManagedNetworkBridges();
      if (request !== readsSent.current) return;
      setManaged(Array.isArray(data.managed) ? data.managed : []);
      setEligibleParents(Array.isArray(data.eligibleParents) ? data.eligibleParents : []);
      setLoadFailed(false);
    } catch (err) {
      if (request !== readsSent.current) return;
      setLoadFailed(true); // the error shows on the card; the list shown stays
      reportError(errorText(err));
    } finally {
      if (request === readsSent.current) setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  /* A bridge create or delete from any tab (announced when its job settles), or a
   * reconnect, re-reads the list. */
  useKindChanges('network-bridges', refresh);

  const onDelete = async (name) => {
    setDeletingName(name);
    reportError(null);
    try {
      await awaitJob((await deleteManagedNetworkBridge(name)).jobId);
    } catch (err) {
      reportError(errorText(err));
    } finally {
      setDeletingName(null);
    }
  };

  const openCreate = () => {
    reportError(null);
    setCreateOpen(true);
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
      helpText="Bridges are how VMs and containers connect to networks. Add one from the header. The host handles VLAN tagging — guests connect untagged."
      headerAction={headerAdd}
    >
      <div className="space-y-4">
        {loading ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : (
          <DataTableScroll>
            <DataTable>
              <thead>
                <tr className={dataTableHeadRowClass}>
                  <DataTableTh dense className="w-48">Name</DataTableTh>
                  <DataTableTh dense className="hidden sm:table-cell">Parent</DataTableTh>
                  <DataTableTh dense className="hidden sm:table-cell">VLAN Id</DataTableTh>
                  <DataTableTh dense className="hidden sm:table-cell">Status</DataTableTh>
                  <DataTableTh dense align="right">Actions</DataTableTh>
                </tr>
              </thead>
              <tbody>
                {managed.length === 0 && (
                  <tr className={dataTableBodyRowClass}>
                    <td colSpan={5} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                      {loadFailed ? "Couldn't load the bridges." : 'No managed VLAN bridges yet.'}
                    </td>
                  </tr>
                )}
                {managed.map((item) => (
                  <tr key={item.name} className={dataTableInteractiveRowClass}>
                    <DataTableTd dense className="w-48 font-mono text-sm text-text-primary">
                      <div className="flex items-baseline justify-between gap-2">
                        <span>{item.name}</span>
                        <span className="font-sans text-xs text-text-muted sm:hidden">{item.baseBridge}</span>
                      </div>
                      <div className="mt-0.5 font-sans text-xs text-text-muted sm:hidden">
                        VLAN {item.vlanId} · {item.present ? 'present' : 'missing'}
                      </div>
                    </DataTableTd>
                    <DataTableTd dense className="hidden font-mono text-sm text-text-secondary sm:table-cell">{item.baseBridge}</DataTableTd>
                    <DataTableTd dense className="hidden tabular-nums text-sm text-text-secondary sm:table-cell">{item.vlanId}</DataTableTd>
                    <DataTableTd dense className="hidden text-sm text-text-secondary sm:table-cell">{item.present ? 'present' : 'missing'}</DataTableTd>
                    <DataTableTd dense align="right">
                      <DataTableRowActions forceVisible={deletingName === item.name}>
                        <button
                          type="button"
                          onClick={() => onDelete(item.name)}
                          disabled={deletingName === item.name}
                          className={`${rowActionIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
                          title={`Delete ${item.name}`}
                          aria-label={`Delete bridge ${item.name}`}
                        >
                          {deletingName === item.name ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                        </button>
                      </DataTableRowActions>
                    </DataTableTd>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </DataTableScroll>
        )}
      </div>
      <BridgeCreateModal
        open={createOpen}
        eligibleParents={eligibleParents}
        onClose={() => setCreateOpen(false)}
      />
    </SectionCard>
  );
}
