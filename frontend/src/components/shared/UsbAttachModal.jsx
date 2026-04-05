import { Loader2, Plus, X } from 'lucide-react';

import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import {
  DataTable,
  DataTableScroll,
  DataTableRowActions,
  DataTableTd,
  DataTableTh,
  dataTableBodyRowClass,
  dataTableEmptyCellClass,
  dataTableHeadRowClass,
  dataTableInteractiveRowClass,
} from './DataTableChrome.jsx';

const attachIconBtn =
  'inline-flex items-center justify-center rounded-md bg-accent p-1.5 text-white hover:bg-accent-hover transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {Array<{ bus: string, device: string, vendorId: string, productId: string, name: string }>} props.devices - Host devices not yet attached to the VM
 * @param {(vendorId: string, productId: string) => void | Promise<void>} props.onAttach
 * @param {string | null} props.actionLoadingKey - `${vendorId}:${productId}` while that attach is in flight, or null
 */
export default function UsbAttachModal({ open, onClose, devices, onAttach, actionLoadingKey }) {
  useEscapeKey(open, onClose);

  if (!open) return null;

  const list = Array.isArray(devices) ? devices : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        className="relative z-10 flex h-[70vh] w-full max-w-3xl flex-col overflow-hidden rounded-card border border-surface-border bg-surface shadow-lg"
        data-wisp-modal-root
      >
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-card px-4 py-3 shrink-0">
          <h2 className="text-sm font-semibold text-text-primary">Attach USB device</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
            title="Close"
            aria-label="Close"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
          <div className="rounded-card border border-surface-border bg-surface-card px-5 py-4">
            <DataTableScroll>
              <DataTable minWidthRem={32}>
                <thead>
                  <tr className={dataTableHeadRowClass}>
                    <DataTableTh dense>Name</DataTableTh>
                    <DataTableTh dense className="whitespace-nowrap">
                      ID
                    </DataTableTh>
                    <DataTableTh dense>Bus / device</DataTableTh>
                    <DataTableTh dense align="right" className="w-14" />
                  </tr>
                </thead>
                <tbody>
                  {list.length === 0 && (
                    <tr className={dataTableBodyRowClass}>
                      <td colSpan={4} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                        No USB devices available to attach. All host devices may already be attached to this VM.
                      </td>
                    </tr>
                  )}
                  {list.map((dev) => {
                    const key = `${dev.vendorId}:${dev.productId}`;
                    const loading = actionLoadingKey === key;
                    return (
                      <tr key={`${dev.bus}-${dev.device}`} className={dataTableInteractiveRowClass}>
                        <DataTableTd dense className="text-sm font-medium text-text-primary">{dev.name}</DataTableTd>
                        <DataTableTd dense className="font-mono text-xs text-text-secondary">
                          {dev.vendorId}:{dev.productId}
                        </DataTableTd>
                        <DataTableTd dense className="text-sm text-text-muted">
                          Bus {dev.bus} · Device {dev.device}
                        </DataTableTd>
                        <DataTableTd dense align="right">
                          <DataTableRowActions forceVisible={loading}>
                            <button
                              type="button"
                              onClick={() => onAttach(dev.vendorId, dev.productId)}
                              disabled={actionLoadingKey != null}
                              className={attachIconBtn}
                              title="Attach"
                              aria-label={`Attach ${dev.name}`}
                            >
                              {loading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plus size={14} aria-hidden />}
                            </button>
                          </DataTableRowActions>
                        </DataTableTd>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            </DataTableScroll>
          </div>
        </div>
      </div>
    </div>
  );
}
