import { useMemo, useState } from 'react';
import { Lock, Network, Shuffle, Plus, Trash2, Pencil, Loader2 } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { randomMac } from '../../utils/randomMac.js';
import { newDraftNic } from '../vm/vmDraft.js';
import { rowId } from '../../hooks/formState.js';
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
import NicEditorModal from './NicEditorModal.jsx';
import NicModelPills from './NicModelPills.jsx';
import RecordError from '../shared/RecordError.jsx';
import { bridgeChoice } from '../shared/bridgeChoice.js';
import { useCommand } from '../../hooks/useCommand.js';
import { RECORD } from '../../store/records.js';
import { vmLocked } from '../../utils/workloadLocks.js';
import { useRecord } from '../../hooks/useRecord.js';

const NO_BRIDGES = [];

/** Compact icon button for the create-flow draft rows (desktop-only layout). */
const draftIconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

/** The NICs of a VM's config, as the rows show them, each with an id of its own (new
 *  when the config's NICs change; they are the record's, never edited here). */
function nicRows(nicsConfig) {
  return (nicsConfig || []).map((nic) => ({
    id: rowId(),
    type: nic.type || 'bridge',
    mac: nic.mac || '',
    source: nic.source || '',
    model: nic.model || 'virtio',
  }));
}

/** The NIC list as the API takes it. */
function nicsForApi(nics) {
  return nics.map(({ type, mac, source, model }) => ({ type, mac, source, model }));
}

/**
 * The VM's network interfaces. Editing a VM, the rows are its config's, and each change
 * is a command: the editor (one NIC, picked when it opens) or a remove. Creating, the
 * panel's draft (`draft`, written through `onDraft(update)`) is the rows, edited in place.
 */
export default function VmNetworkInterfacesSection({ vmConfig, isCreating, draft, onDraft, onSave, busyReason }) {
  const isStopped = !vmLocked(vmConfig.state);
  /* busyReason: another operation (a backup) holds the VM's backend lock —
   * a NIC save (PATCH) would be refused with 409 VM_BUSY. */
  const vmBusy = !!busyReason && !isCreating;
  const networkLocked = (!isStopped && !isCreating) || vmBusy;

  const configNics = useMemo(() => nicRows(vmConfig.nics), [vmConfig.nics]);
  const nics = isCreating ? draft : configNics;
  /* The bridges a NIC can take, kept current as bridges are made or removed. */
  const bridgesRecord = useRecord(RECORD.HOST_BRIDGES);
  const bridges = bridgesRecord.data ?? NO_BRIDGES;

  /* The editor: the position of the NIC it edits and the NIC as it opened (null to add). */
  const [editor, setEditor] = useState({ open: false, index: null, opened: null });
  /* A NIC's removal, keyed by its row (about: its MAC). Each re-sends the whole `nics`
   * array, so one runs at a time: the other rows' controls and Add are disabled
   * meanwhile. */
  const remove = useCommand();

  /* Create flow only: draft rows are edited in place in the panel's draft. */
  const updateNic = (id, key, value) => {
    onDraft((rows) => rows.map((n) => (n.id === id ? { ...n, [key]: value } : n)));
  };

  const addDraftNic = () => onDraft((rows) => [...rows, newDraftNic(bridges[0] || '')]);

  const openEditor = (index) => {
    if (networkLocked) return;
    setEditor({ open: true, index, opened: index == null ? null : configNics[index] });
  };

  const closeEditor = () => setEditor({ open: false, index: null, opened: null });

  /**
   * The editor's command: every NIC change re-PATCHes the whole `nics` array (the
   * documented exception, see docs/FRONTEND-RULES.md § Variants — **VM — Network
   * interfaces**), built from the config as it is when the editor saves.
   */
  const submitNic = (fields, index) => {
    const next = index === null
      ? [...configNics, { type: 'bridge', ...fields }]
      : configNics.map((n, i) => (i === index ? { ...n, ...fields } : n));
    return onSave({ nics: nicsForApi(next) });
  };

  const removeNic = (nic) => {
    if (nics.length <= 1) return;
    if (isCreating) {
      onDraft((rows) => rows.filter((n) => n.id !== nic.id));
      return;
    }
    const next = configNics.filter((n) => n.id !== nic.id);
    /* A remove is a command: busy until the server answers. */
    remove.run(() => onSave({ nics: nicsForApi(next) }), { key: nic.id, about: nic.mac });
  };

  /* Create stays desktop-oriented (UI.md § Responsive behavior): its draft rows
   * hide their Actions below `sm`, so Add hides with them. */
  const headerAdd = (
    <button
      type="button"
      onClick={() => (isCreating ? addDraftNic() : openEditor(null))}
      disabled={networkLocked || remove.busy}
      className={`${isCreating ? 'hidden sm:inline-flex' : 'inline-flex'} items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed`}
      title={vmBusy ? busyReason : networkLocked ? 'Stop the VM to add a NIC' : 'Add NIC'}
      aria-label="Add NIC"
    >
      <Plus size={14} aria-hidden />
      <Network size={14} aria-hidden />
    </button>
  );

  return (
    <SectionCard
      title="Network interfaces"
      helpText={
        isCreating
          ? 'Configure bridges and MACs now — changes apply when you create the VM.'
          : 'Add or edit an interface in a form; every change re-saves the whole NIC list. Editing requires the VM to be stopped.'
      }
      requiresRestart={!!vmConfig.pendingRestart}
      commands={[remove]}
      errorPrefix={(key, command, mac) => `Couldn't remove the NIC ${mac ?? ''}`.trim()}
      headerAction={headerAdd}
    >
      <RecordError record={bridgesRecord} what="host bridges" className="mb-2" />
      <DataTableScroll>
        <DataTable>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense className="w-12 sm:w-16">
                #
              </DataTableTh>
              <DataTableTh dense className="sm:min-w-28">
                Bridge
              </DataTableTh>
              <DataTableTh dense className={isCreating ? '' : 'hidden sm:table-cell'}>
                Model
              </DataTableTh>
              <DataTableTh dense className={`sm:min-w-48 ${isCreating ? '' : 'hidden sm:table-cell'}`}>
                MAC
              </DataTableTh>
              <DataTableTh dense align="right" className={isCreating ? 'hidden sm:table-cell' : ''}>
                Actions
              </DataTableTh>
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
            {nics.map((nic, idx) => {
              const removing = remove.isBusy(nic.id);

              return (
                <tr key={nic.id} className={dataTableInteractiveRowClass}>
                  <DataTableTd dense className="text-xs font-medium text-text-secondary">
                    net{idx}
                  </DataTableTd>
                  <DataTableTd dense>
                    {isCreating ? (
                      /* No bridge chosen: the first is the selected option, and what is sent. */
                      <select
                        value={nic.source || bridges[0] || ''}
                        onChange={(e) => updateNic(nic.id, 'source', e.target.value)}
                        className="input-field h-8 w-full min-w-24 max-w-44 text-xs"
                      >
                        {!nic.source && bridges.length === 0 && <option value="">{bridgeChoice(bridgesRecord)}</option>}
                        {bridges.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                        {nic.source && !bridges.includes(nic.source) && (
                          <option value={nic.source}>{nic.source}</option>
                        )}
                      </select>
                    ) : (
                      <>
                        <span className="font-mono text-sm text-text-primary">{nic.source || '—'}</span>
                        {/* Model + MAC stack here below `sm`, where their columns are hidden. */}
                        <div className="mt-0.5 font-mono text-[11px] text-text-secondary sm:hidden">
                          {nic.model} · {nic.mac || '—'}
                        </div>
                      </>
                    )}
                  </DataTableTd>
                  <DataTableTd dense className={isCreating ? '' : 'hidden sm:table-cell'}>
                    {isCreating ? (
                      <NicModelPills
                        value={nic.model}
                        onChange={(v) => updateNic(nic.id, 'model', v)}
                      />
                    ) : (
                      <span className="text-sm text-text-secondary">{nic.model}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense className={isCreating ? '' : 'hidden sm:table-cell'}>
                    {isCreating ? (
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
                    ) : (
                      <span className="font-mono text-xs text-text-primary">{nic.mac || '—'}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd
                    dense
                    align="right"
                    className={isCreating ? 'hidden sm:table-cell' : ''}
                  >
                    <DataTableRowActions forceVisible={isCreating || removing}>
                      {!isCreating && (
                        <button
                          type="button"
                          onClick={() => openEditor(idx)}
                          disabled={networkLocked || remove.busy}
                          className={rowActionIconBtn}
                          title={vmBusy ? busyReason : networkLocked ? 'Stop the VM to edit NICs' : 'Edit'}
                          aria-label={`Edit NIC net${idx}`}
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                      )}
                      {nics.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeNic(nic)}
                          disabled={networkLocked || remove.busy}
                          className={`${isCreating ? draftIconBtn : rowActionIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
                          title={vmBusy ? busyReason : networkLocked ? 'Stop the VM to remove NICs' : 'Remove NIC'}
                          aria-label={`Remove NIC net${idx}`}
                        >
                          {removing ? (
                            <Loader2 size={14} className="animate-spin" aria-hidden />
                          ) : (
                            <Trash2 size={13} aria-hidden />
                          )}
                        </button>
                      )}
                    </DataTableRowActions>
                  </DataTableTd>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </DataTableScroll>

      {networkLocked && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-text-muted">
          <Lock size={11} aria-hidden />
          {vmBusy ? busyReason : 'Stop the VM to change bridges, models, or MACs.'}
        </p>
      )}

      <NicEditorModal
        open={editor.open}
        index={editor.index ?? nics.length}
        opened={editor.opened}
        bridges={bridges}
        onSubmit={submitNic}
        onClose={closeEditor}
      />
    </SectionCard>
  );
}
