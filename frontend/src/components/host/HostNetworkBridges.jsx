import { useState } from 'react';
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
import { useCommand } from '../../hooks/useCommand.js';
import { deleteManagedNetworkBridge } from '../../api/host.js';
import RecordGate from '../shared/RecordGate.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import RecordError from '../shared/RecordError.jsx';

const NO_BRIDGES = [];

export default function HostNetworkBridges() {
  /* A bridge's delete, keyed by its name: a job, busy until it ended. Its error shows
   * in this section. */
  const remove = useCommand();
  const [createOpen, setCreateOpen] = useState(false);
  /* The managed bridges, read again when a create or delete settles (any tab). */
  const bridges = useRecord(RECORD.NETWORK_BRIDGES);
  const managed = Array.isArray(bridges.data?.managed) ? bridges.data.managed : NO_BRIDGES;
  const eligibleParents = Array.isArray(bridges.data?.eligibleParents) ? bridges.data.eligibleParents : NO_BRIDGES;

  const onDelete = (name) => remove.run(() => deleteManagedNetworkBridge(name), {
    job: true, key: name,
  });

  const openCreate = () => setCreateOpen(true);

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
      commands={[remove]}
      errorPrefix={(name) => `Couldn't delete ${name}`}
    >
      <div className="space-y-4">
        {bridges.data != null && <RecordError record={bridges} what="network bridges" />}
        <RecordGate record={bridges} what="network bridges">
          {() => (
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
                        No managed VLAN bridges yet.
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
                        <DataTableRowActions forceVisible={remove.isBusy(item.name)}>
                          <button
                            type="button"
                            onClick={() => onDelete(item.name)}
                            disabled={remove.isBusy(item.name)}
                            className={`${rowActionIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
                            title={`Delete ${item.name}`}
                            aria-label={`Delete bridge ${item.name}`}
                          >
                            {remove.isBusy(item.name) ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                          </button>
                        </DataTableRowActions>
                      </DataTableTd>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </DataTableScroll>
          )}
        </RecordGate>
      </div>
      <BridgeCreateModal
        open={createOpen}
        eligibleParents={eligibleParents}
        onClose={() => setCreateOpen(false)}
      />
    </SectionCard>
  );
}
