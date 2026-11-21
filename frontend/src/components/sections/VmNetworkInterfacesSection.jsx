import { Network, Shuffle, Plus, Trash2 } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { randomMac } from '../../utils/randomMac.js';
import { newDraftNic } from '../vm/vmDraft.js';
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
} from '../shared/DataTableChrome.jsx';
import NicModelPills from './NicModelPills.jsx';
import RecordError from '../shared/RecordError.jsx';
import { bridgeChoice } from '../shared/bridgeChoice.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';

const NO_BRIDGES = [];

/** Compact icon button for the draft rows (desktop-only layout). */
const draftIconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

/**
 * The Create VM panel's network interfaces: the panel's draft (`draft`, written through
 * `onDraft(update)`) is the rows, edited in place.
 */
export default function VmNetworkInterfacesSection({ draft, onDraft }) {
  const nics = draft;
  /* The bridges a NIC can take, kept current as bridges are made or removed. */
  const bridgesRecord = useRecord(RECORD.HOST_BRIDGES);
  const bridges = bridgesRecord.data ?? NO_BRIDGES;

  const updateNic = (id, key, value) => {
    onDraft((rows) => rows.map((n) => (n.id === id ? { ...n, [key]: value } : n)));
  };
  const addDraftNic = () => onDraft((rows) => [...rows, newDraftNic(bridges[0] || '')]);
  const removeNic = (nic) => {
    if (nics.length <= 1) return;
    onDraft((rows) => rows.filter((n) => n.id !== nic.id));
  };

  /* Create stays desktop-oriented: its draft rows hide their Actions below `sm`, so Add
   * hides with them. */
  const headerAdd = (
    <button
      type="button"
      onClick={addDraftNic}
      className="hidden sm:inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Add NIC"
      aria-label="Add NIC"
    >
      <Plus size={14} aria-hidden />
      <Network size={14} aria-hidden />
    </button>
  );

  return (
    <SectionCard
      title="Network interfaces"
      helpText="Configure bridges and MACs now — changes apply when you create the VM."
      headerAction={headerAdd}
    >
      <RecordError record={bridgesRecord} what="host bridges" className="mb-2" />
      <DataTableScroll>
        <DataTable>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense className="w-12 sm:w-16">#</DataTableTh>
              <DataTableTh dense className="sm:min-w-28">Bridge</DataTableTh>
              <DataTableTh dense>Model</DataTableTh>
              <DataTableTh dense className="sm:min-w-48">MAC</DataTableTh>
              <DataTableTh dense align="right" className="hidden sm:table-cell">Actions</DataTableTh>
            </tr>
          </thead>
          <tbody>
            {nics.length === 0 && (
              <tr className={dataTableBodyRowClass}>
                <td colSpan={5} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                  No network interfaces. Use Add in the header.
                </td>
              </tr>
            )}
            {nics.map((nic, idx) => (
              <tr key={nic.id} className={dataTableInteractiveRowClass}>
                <DataTableTd dense className="text-xs font-medium text-text-secondary">net{idx}</DataTableTd>
                <DataTableTd dense>
                  {/* No bridge chosen: the first is the selected option, and what is sent. */}
                  <select
                    value={nic.source || bridges[0] || ''}
                    onChange={(e) => updateNic(nic.id, 'source', e.target.value)}
                    className="input-field h-8 w-full min-w-24 max-w-44 text-xs"
                  >
                    {!nic.source && bridges.length === 0 && <option value="">{bridgeChoice(bridgesRecord)}</option>}
                    {bridges.map((b) => <option key={b} value={b}>{b}</option>)}
                    {nic.source && !bridges.includes(nic.source) && <option value={nic.source}>{nic.source}</option>}
                  </select>
                </DataTableTd>
                <DataTableTd dense>
                  <NicModelPills value={nic.model} onChange={(v) => updateNic(nic.id, 'model', v)} />
                </DataTableTd>
                <DataTableTd dense>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      type="text"
                      value={nic.mac}
                      onChange={(e) => updateNic(nic.id, 'mac', e.target.value)}
                      className="input-field h-8 min-w-32 max-w-48 font-mono text-[11px]"
                    />
                    <button
                      type="button"
                      onClick={() => updateNic(nic.id, 'mac', randomMac())}
                      className={`${draftIconBtn} shrink-0`}
                      title="Randomize MAC"
                      aria-label="Randomize MAC"
                    >
                      <Shuffle size={13} aria-hidden />
                    </button>
                  </div>
                </DataTableTd>
                <DataTableTd dense align="right" className="hidden sm:table-cell">
                  <DataTableRowActions forceVisible>
                    {nics.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeNic(nic)}
                        className={`${draftIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
                        title="Remove NIC"
                        aria-label={`Remove NIC net${idx}`}
                      >
                        <Trash2 size={13} aria-hidden />
                      </button>
                    )}
                  </DataTableRowActions>
                </DataTableTd>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </DataTableScroll>
    </SectionCard>
  );
}
