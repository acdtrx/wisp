import { useState, useEffect } from 'react';
import { Lock, Network, Shuffle, Plus, Trash2, Pencil, Loader2 } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { getHostBridges } from '../../api/vms.js';
import { randomMac } from '../../utils/randomMac.js';
import { randomId } from '../../utils/randomId.js';
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

/** Compact icon button for the create-flow draft rows (desktop-only layout). */
const draftIconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function initNicsFromConfig(nicsConfig) {
  return (nicsConfig || []).map((nic, i) => ({
    _key: nic._key ?? i,
    type: nic.type || 'bridge',
    mac: nic.mac || '',
    source: nic.source || '',
    model: nic.model || 'virtio',
  }));
}

function normalizeNicsForApi(nics) {
  return nics.map(({ type, mac, source, model }) => ({
    type,
    mac,
    source,
    model,
  }));
}

export default function VmNetworkInterfacesSection({ vmConfig, isCreating, onSave, onFormChange }) {
  const isStopped = vmConfig.state === 'shutoff' || vmConfig.state === 'nostate';
  const networkLocked = !isStopped && !isCreating;

  const [nics, setNics] = useState(() => initNicsFromConfig(vmConfig.nics));
  const [bridges, setBridges] = useState([]);
  const nicsSignature = JSON.stringify(vmConfig.nics || []);

  /* The row is snapshotted when the editor opens so a background refresh of
   * `vmConfig.nics` can't reset the open form; `idx` is null when adding. */
  const [editor, setEditor] = useState({ open: false, idx: null, nic: null });
  const [removingIdx, setRemovingIdx] = useState(null);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);

  useEffect(() => {
    setNics(initNicsFromConfig(vmConfig.nics));
  }, [nicsSignature]);

  useEffect(() => {
    /* Non-fatal: NIC section works with an empty bridge list if host bridges fail to load */
    getHostBridges().then(setBridges).catch(() => {});
  }, []);

  const syncNicsToParent = (nextNics) => {
    if (isCreating && onFormChange) onFormChange({ nics: nextNics });
  };

  /* Create flow only: draft rows are edited in place and pushed to the parent
   * form. The parent sync stays outside setNics — calling it from inside the
   * updater is a render-phase parent setState, which React warns about. */
  const updateNic = (idx, key, value) => {
    const next = nics.map((n, i) => (i === idx ? { ...n, [key]: value } : n));
    setNics(next);
    syncNicsToParent(next);
  };

  const addDraftNic = () => {
    const next = [
      ...nics,
      {
        _key: randomId(),
        type: 'bridge',
        mac: randomMac(),
        source: bridges[0] || '',
        model: 'virtio',
      },
    ];
    setNics(next);
    syncNicsToParent(next);
  };

  const openEditor = (idx) => {
    if (networkLocked) return;
    setError(null);
    setEditor({ open: true, idx, nic: idx === null ? null : nics[idx] });
  };

  const closeEditor = () => setEditor({ open: false, idx: null, nic: null });

  /**
   * Save path for the editor modal: every NIC change re-PATCHes the whole
   * `nics` array (the documented exception, see docs/UI-PATTERNS.md § Variants
   * — **VM — Network interfaces**). Failures propagate so the modal can show
   * them and stay open.
   */
  const submitNic = async (fields) => {
    const { idx } = editor;
    const next = idx === null
      ? [...nics, { _key: randomId(), type: 'bridge', ...fields }]
      : nics.map((n, i) => (i === idx ? { ...n, ...fields } : n));
    setError(null);
    const result = await onSave({ nics: normalizeNicsForApi(next) });
    if (result?.requiresRestart) setRequiresRestart(true);
    setNics(next);
    return result;
  };

  const removeNicAt = async (idx) => {
    if (nics.length <= 1) return;
    setError(null);
    const next = nics.filter((_, i) => i !== idx);
    if (isCreating) {
      setNics(next);
      syncNicsToParent(next);
      return;
    }
    setRemovingIdx(idx);
    try {
      const result = await onSave({ nics: normalizeNicsForApi(next) });
      if (result?.requiresRestart) setRequiresRestart(true);
      setNics(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setRemovingIdx(null);
    }
  };

  /* Create stays desktop-oriented (UI.md § Responsive behavior): its draft rows
   * hide their Actions below `sm`, so Add hides with them. */
  const headerAdd = (
    <button
      type="button"
      onClick={() => (isCreating ? addDraftNic() : openEditor(null))}
      disabled={networkLocked}
      className={`${isCreating ? 'hidden sm:inline-flex' : 'inline-flex'} items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed`}
      title={networkLocked ? 'Stop the VM to add a NIC' : 'Add NIC'}
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
      requiresRestart={requiresRestart}
      error={error}
      headerAction={headerAdd}
    >
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
              const removing = removingIdx === idx;

              return (
                <tr key={nic._key} className={dataTableInteractiveRowClass}>
                  <DataTableTd dense className="text-xs font-medium text-text-secondary">
                    net{idx}
                  </DataTableTd>
                  <DataTableTd dense>
                    {isCreating ? (
                      <select
                        value={nic.source}
                        onChange={(e) => updateNic(idx, 'source', e.target.value)}
                        className="input-field h-8 w-full min-w-24 max-w-44 text-xs"
                      >
                        {!nic.source && <option value="">Select…</option>}
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
                        onChange={(v) => updateNic(idx, 'model', v)}
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
                          onChange={(e) => updateNic(idx, 'mac', e.target.value)}
                          className="input-field h-8 min-w-32 max-w-48 font-mono text-[11px]"
                        />
                        <button
                          type="button"
                          onClick={() => updateNic(idx, 'mac', randomMac())}
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
                          disabled={networkLocked}
                          className={rowActionIconBtn}
                          title={networkLocked ? 'Stop the VM to edit NICs' : 'Edit'}
                          aria-label={`Edit NIC net${idx}`}
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                      )}
                      {nics.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeNicAt(idx)}
                          disabled={networkLocked || removing}
                          className={`${isCreating ? draftIconBtn : rowActionIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
                          title={networkLocked ? 'Stop the VM to remove NICs' : 'Remove NIC'}
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
          Stop the VM to change bridges, models, or MACs.
        </p>
      )}

      <NicEditorModal
        open={editor.open}
        nic={editor.nic}
        index={editor.idx === null ? nics.length : editor.idx}
        bridges={bridges}
        onSubmit={submitNic}
        onClose={closeEditor}
      />
    </SectionCard>
  );
}
