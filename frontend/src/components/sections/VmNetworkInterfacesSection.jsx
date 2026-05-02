import { useState, useEffect } from 'react';
import {
  Lock,
  Network,
  Shuffle,
  Plus,
  Trash2,
  Pencil,
  Save,
  X,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

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
  rowActionIconBtnPrimary,
} from '../shared/DataTableChrome.jsx';

const NIC_MODEL_OPTIONS = [
  { value: 'virtio', label: 'VirtIO' },
  { value: 'e1000', label: 'e1000' },
  { value: 'rtl8139', label: 'rtl8139' },
];

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function NicModelSegmentedControl({ value, onChange, disabled }) {
  return (
    <div className="flex h-8 min-w-[220px] max-w-[300px] rounded-lg border border-surface-border bg-surface p-0.5">
      {NIC_MODEL_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => !disabled && onChange(opt.value)}
          disabled={disabled}
          className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors duration-150 ${
            value === opt.value
              ? 'bg-surface-card text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function initNicsFromConfig(nicsConfig) {
  return (nicsConfig || []).map((nic, i) => ({
    _key: nic._key ?? i,
    type: nic.type || 'bridge',
    mac: nic.mac || '',
    source: nic.source || '',
    model: nic.model || 'virtio',
    vlan: nic.vlan ?? '',
  }));
}

function normalizeNicsForApi(nics) {
  return nics.map(({ type, mac, source, model }) => ({
    type,
    mac,
    source,
    model,
    vlan: null,
  }));
}

function nicRowEquals(a, b) {
  return (
    a.type === b.type
    && a.mac === b.mac
    && a.source === b.source
    && a.model === b.model
    && String(a.vlan ?? '') === String(b.vlan ?? '')
  );
}

export default function VmNetworkInterfacesSection({ vmConfig, isCreating, onSave, onFormChange }) {
  const isRunning = vmConfig.state === 'running' || vmConfig.state === 'blocked';
  const isStopped = vmConfig.state === 'shutoff' || vmConfig.state === 'nostate';
  const networkLocked = !isStopped && !isCreating;

  const [nics, setNics] = useState(() => initNicsFromConfig(vmConfig.nics));
  const [originalNics, setOriginalNics] = useState(() => initNicsFromConfig(vmConfig.nics));
  const [bridges, setBridges] = useState([]);
  const nicsSignature = JSON.stringify(vmConfig.nics || []);

  const [editingIdx, setEditingIdx] = useState(null);
  const [savingIdx, setSavingIdx] = useState(null);
  const [removingIdx, setRemovingIdx] = useState(null);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);

  useEffect(() => {
    const data = initNicsFromConfig(vmConfig.nics);
    setNics(data);
    setOriginalNics(data);
    setEditingIdx(null);
  }, [nicsSignature]);

  useEffect(() => {
    /* Non-fatal: NIC section works with an empty bridge list if host bridges fail to load */
    getHostBridges().then(setBridges).catch(() => {});
  }, []);

  const syncNicsToParent = (nextNics) => {
    if (isCreating && onFormChange) onFormChange({ nics: nextNics });
  };

  const updateNic = (idx, key, value) => {
    setNics((prev) => {
      const next = prev.map((n, i) => (i === idx ? { ...n, [key]: value } : n));
      syncNicsToParent(next);
      return next;
    });
  };

  const addNic = () => {
    setNics((prev) => {
      const next = [
        ...prev,
        {
          _key: randomId(),
          type: 'bridge',
          mac: randomMac(),
          source: bridges[0] || '',
          model: 'virtio',
          vlan: '',
        },
      ];
      syncNicsToParent(next);
      if (!isCreating) setEditingIdx(next.length - 1);
      return next;
    });
  };

  const removeNicAt = async (idx) => {
    if (nics.length <= 1) return;
    setError(null);
    const next = nics.filter((_, i) => i !== idx);
    if (isCreating) {
      setNics(next);
      syncNicsToParent(next);
      setEditingIdx((e) => {
        if (e === null) return null;
        if (e === idx) return null;
        if (e > idx) return e - 1;
        return e;
      });
      return;
    }
    setRemovingIdx(idx);
    try {
      const result = await onSave({ nics: normalizeNicsForApi(next) });
      if (result?.requiresRestart) setRequiresRestart(true);
      const normalizedUi = next.map((nic) => ({ ...nic, vlan: '' }));
      setNics(normalizedUi);
      setOriginalNics(normalizedUi);
      setEditingIdx(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setRemovingIdx(null);
    }
  };

  const startEdit = (idx) => {
    if (networkLocked) return;
    setEditingIdx(idx);
    setError(null);
  };

  const cancelEdit = (idx) => {
    setNics((prev) => {
      const o = originalNics[idx];
      if (!o) return prev;
      const next = prev.map((n, i) => (i === idx ? { ...o, _key: n._key } : n));
      if (isCreating) syncNicsToParent(next);
      return next;
    });
    setEditingIdx(null);
  };

  const saveRow = async (idx) => {
    if (isCreating) {
      setEditingIdx(null);
      return;
    }
    setSavingIdx(idx);
    setError(null);
    try {
      const normalizedNics = normalizeNicsForApi(nics);
      const result = await onSave({ nics: normalizedNics });
      const normalizedUi = nics.map((nic) => ({ ...nic, vlan: '' }));
      setNics(normalizedUi);
      setOriginalNics(normalizedUi);
      if (result?.requiresRestart) setRequiresRestart(true);
      setEditingIdx(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingIdx(null);
    }
  };

  const headerAdd =
    isStopped || isCreating ? (
      <button
        type="button"
        onClick={addNic}
        className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
        title="Add NIC"
        aria-label="Add NIC"
      >
        <Plus size={14} aria-hidden />
        <Network size={14} aria-hidden />
      </button>
    ) : undefined;

  const rowDirty = (idx) => {
    const n = nics[idx];
    const o = originalNics[idx];
    if (!n || !o) return true;
    return !nicRowEquals(n, o);
  };

  return (
    <SectionCard
      title="Network interfaces"
      helpText={
        isCreating
          ? 'Configure bridges and MACs now — changes apply when you create the VM.'
          : 'Each NIC saves with the row Save button. Hover a row to see actions.'
      }
      requiresRestart={requiresRestart}
      error={error}
      headerAction={headerAdd}
      locked={networkLocked && !isCreating}
      lockedMessage="Stop the VM to edit interfaces"
    >
      <DataTableScroll>
        <DataTable minWidthRem={52}>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense className="w-16">
                #
              </DataTableTh>
              <DataTableTh dense className="min-w-[7rem]">
                Bridge
              </DataTableTh>
              <DataTableTh dense className="w-20">
                VLAN
              </DataTableTh>
              <DataTableTh dense>Model</DataTableTh>
              <DataTableTh dense className="min-w-[12rem]">
                MAC
              </DataTableTh>
              <DataTableTh dense align="right">
                Actions
              </DataTableTh>
            </tr>
          </thead>
          <tbody>
            {nics.length === 0 && (
              <tr className={dataTableBodyRowClass}>
                <td colSpan={6} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                  No network interfaces. Use Add in the header.
                </td>
              </tr>
            )}
            {nics.map((nic, idx) => {
              const showInputs = isCreating || editingIdx === idx;
              const dirty = rowDirty(idx);
              const canSave = !isCreating && editingIdx === idx && dirty && savingIdx !== idx;
              const macWarn = !isCreating && idx === 0 && nic.mac !== (originalNics[0]?.mac ?? '');

              const actionsForce =
                isCreating
                || editingIdx === idx
                || savingIdx === idx
                || removingIdx === idx;

              return (
                <tr key={nic._key} className={dataTableInteractiveRowClass}>
                  <DataTableTd dense className="text-xs font-medium text-text-secondary">
                    net
                    {idx}
                  </DataTableTd>
                  <DataTableTd dense>
                    {showInputs ? (
                      <select
                        value={nic.source}
                        onChange={(e) => updateNic(idx, 'source', e.target.value)}
                        disabled={networkLocked}
                        className="input-field h-8 w-full min-w-[6rem] max-w-[11rem] text-xs"
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
                      <span className="font-mono text-sm text-text-primary">{nic.source || '—'}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense>
                    {showInputs ? (
                      <input
                        type="number"
                        min={1}
                        max={4094}
                        placeholder="—"
                        value={nic.vlan}
                        onChange={(e) => updateNic(idx, 'vlan', e.target.value)}
                        disabled
                        className="input-field h-8 w-full text-xs"
                      />
                    ) : (
                      <span className="text-sm text-text-muted tabular-nums">{nic.vlan || '—'}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense>
                    {showInputs ? (
                      <NicModelSegmentedControl
                        value={nic.model}
                        onChange={(v) => updateNic(idx, 'model', v)}
                        disabled={networkLocked}
                      />
                    ) : (
                      <span className="text-sm text-text-secondary">{nic.model}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense>
                    {showInputs ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input
                          type="text"
                          value={nic.mac}
                          onChange={(e) => updateNic(idx, 'mac', e.target.value)}
                          disabled={networkLocked}
                          className="input-field h-8 min-w-[8rem] max-w-[12rem] font-mono text-[11px]"
                        />
                        {(isStopped || isCreating) && (
                          <button
                            type="button"
                            onClick={() => updateNic(idx, 'mac', randomMac())}
                            className={`${iconBtn} shrink-0`}
                            title="Randomize MAC"
                            aria-label="Randomize MAC"
                          >
                            <Shuffle size={13} aria-hidden />
                          </button>
                        )}
                        {macWarn && (
                          <span
                            className="shrink-0 text-amber-500"
                            title="If this VM uses cloud-init, re-save cloud-init after changing the MAC."
                          >
                            <AlertTriangle size={16} aria-hidden />
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-text-primary">
                        {nic.mac || '—'}
                        {macWarn && (
                          <span
                            className="text-amber-500"
                            title="If this VM uses cloud-init, re-save cloud-init after changing the MAC."
                          >
                            <AlertTriangle size={14} aria-hidden />
                          </span>
                        )}
                      </span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense align="right">
                    <DataTableRowActions forceVisible={actionsForce}>
                      {!isCreating && !networkLocked && !showInputs && (
                        <button
                          type="button"
                          onClick={() => startEdit(idx)}
                          className={iconBtn}
                          title="Edit"
                          aria-label={`Edit NIC net${idx}`}
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                      )}
                      {!isCreating && showInputs && (
                        <>
                          <button
                            type="button"
                            onClick={() => saveRow(idx)}
                            disabled={!canSave}
                            className={rowActionIconBtnPrimary}
                            title="Save NICs"
                            aria-label={`Save network interfaces (${dirty ? 'unsaved' : 'unchanged'})`}
                          >
                            {savingIdx === idx ? (
                              <Loader2 size={14} className="animate-spin" aria-hidden />
                            ) : (
                              <Save size={14} aria-hidden />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => cancelEdit(idx)}
                            disabled={savingIdx === idx}
                            className={iconBtn}
                            title="Cancel edit"
                            aria-label="Cancel edit"
                          >
                            <X size={14} aria-hidden />
                          </button>
                        </>
                      )}
                      {nics.length > 1 && (isStopped || isCreating) && (
                        <button
                          type="button"
                          onClick={() => removeNicAt(idx)}
                          disabled={removingIdx === idx || savingIdx === idx}
                          className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-red-50`}
                          title="Remove NIC"
                          aria-label={`Remove NIC net${idx}`}
                        >
                          {removingIdx === idx ? (
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

      {networkLocked && !isCreating && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-text-muted">
          <Lock size={11} aria-hidden />
          Stop the VM to change bridges, models, or MACs.
        </p>
      )}
    </SectionCard>
  );
}
