import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, Plus, Unplug, Usb } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import UsbAttachModal from '../shared/UsbAttachModal.jsx';
import { getVMUSB, attachUSBToVM, detachUSBFromVM } from '../../api/vms.js';
import { useUsbStore } from '../../store/usbStore.js';
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

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface hover:text-status-stopped transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

export default function USBSection({ vmConfig }) {
  const hostDevices = useUsbStore((s) => s.devices);
  const connectUsb = useUsbStore((s) => s.connect);
  const disconnectUsb = useUsbStore((s) => s.disconnect);

  const [attachedDevices, setAttachedDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [error, setError] = useState(null);
  const [attachModalOpen, setAttachModalOpen] = useState(false);
  const abortRef = useRef(null);

  const vmName = vmConfig?.name;

  useEffect(() => {
    connectUsb();
    return () => disconnectUsb();
  }, [connectUsb, disconnectUsb]);

  const fetchAttachedOnly = useCallback(async (signal) => {
    try {
      const attached = vmName ? await getVMUSB(vmName).catch(() => []) : [];
      if (signal?.aborted) return;
      setAttachedDevices(attached);
      setLoading(false);
    } catch {
      if (signal?.aborted) return;
      setLoading(false);
    }
  }, [vmName]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    fetchAttachedOnly(controller.signal);
    return () => controller.abort();
  }, [fetchAttachedOnly]);

  const handleAttach = async (vendorId, productId) => {
    const key = `${vendorId}:${productId}`;
    setActionLoading(key);
    setError(null);
    try {
      await attachUSBToVM(vmName, vendorId, productId);
      await fetchAttachedOnly(abortRef.current?.signal);
      setAttachModalOpen(false);
    } catch (err) {
      setError(err.message || 'Failed to attach USB device');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDetach = async (vendorId, productId) => {
    const key = `${vendorId}:${productId}`;
    setActionLoading(key);
    setError(null);
    try {
      await detachUSBFromVM(vmName, vendorId, productId);
      await fetchAttachedOnly(abortRef.current?.signal);
    } catch (err) {
      setError(err.message || 'Failed to detach USB device');
    } finally {
      setActionLoading(null);
    }
  };

  const hostList = hostDevices ?? [];
  const hostLoading = hostDevices === null;

  const attachedSet = new Set(attachedDevices.map((d) => `${d.vendorId}:${d.productId}`));

  const attachedWithNames = attachedDevices.map((d) => {
    const host = hostList.find((h) => h.vendorId === d.vendorId && h.productId === d.productId);
    return { ...d, name: host?.name || 'Unknown Device', bus: host?.bus, device: host?.device };
  });

  const available = hostList.filter((d) => !attachedSet.has(`${d.vendorId}:${d.productId}`));

  const showSpinner = loading || hostLoading;

  const headerAttach =
    hostList.length > 0 ? (
      <button
        type="button"
        onClick={() => setAttachModalOpen(true)}
        className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
        title="Attach USB device"
        aria-label="Attach USB device"
      >
        <Plus size={14} aria-hidden />
        <Usb size={14} aria-hidden />
      </button>
    ) : (
      <button
        type="button"
        disabled
        className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white opacity-40 cursor-not-allowed"
        title="No USB devices on host"
        aria-label="Attach USB device unavailable"
      >
        <Plus size={14} aria-hidden />
        <Usb size={14} aria-hidden />
      </button>
    );

  return (
    <SectionCard
      title="USB Devices"
      titleIcon={<Usb size={14} strokeWidth={2} />}
      error={error}
      headerAction={headerAttach}
    >
      <UsbAttachModal
        open={attachModalOpen}
        onClose={() => setAttachModalOpen(false)}
        devices={available}
        onAttach={handleAttach}
        actionLoadingKey={actionLoading}
      />

      {showSpinner ? (
        <p className="text-xs text-text-muted py-2">Loading USB devices…</p>
      ) : hostList.length === 0 && attachedDevices.length === 0 ? (
        <div className="flex flex-col items-center py-6 text-center">
          <Usb size={24} className="text-text-muted mb-2" />
          <p className="text-xs text-text-muted">No USB devices detected on host</p>
        </div>
      ) : (
        <DataTableScroll>
          <DataTable minWidthRem={36}>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense>Name</DataTableTh>
                <DataTableTh dense className="whitespace-nowrap">
                  ID
                </DataTableTh>
                <DataTableTh dense>Bus / device</DataTableTh>
                <DataTableTh dense align="right">
                  Actions
                </DataTableTh>
              </tr>
            </thead>
            <tbody>
              {attachedWithNames.length === 0 && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={4} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                    No devices attached. Use Attach in the section header to add a host USB device.
                  </td>
                </tr>
              )}
              {attachedWithNames.map((dev) => {
                const key = `${dev.vendorId}:${dev.productId}`;
                const rowBusy = actionLoading === key;
                return (
                  <tr key={key} className={dataTableInteractiveRowClass}>
                    <DataTableTd dense className="font-medium text-text-primary">{dev.name}</DataTableTd>
                    <DataTableTd dense className="font-mono text-text-secondary">
                      {dev.vendorId}:{dev.productId}
                    </DataTableTd>
                    <DataTableTd dense className="text-text-muted">
                      {dev.bus != null && dev.device != null ? `Bus ${dev.bus} · Device ${dev.device}` : '—'}
                    </DataTableTd>
                    <DataTableTd dense align="right">
                      <DataTableRowActions forceVisible={rowBusy}>
                        <button
                          type="button"
                          onClick={() => handleDetach(dev.vendorId, dev.productId)}
                          disabled={actionLoading != null}
                          className={iconBtn}
                          title="Detach"
                          aria-label="Detach"
                        >
                          {rowBusy ? <Loader2 size={14} className="animate-spin text-text-secondary" aria-hidden /> : <Unplug size={14} aria-hidden />}
                        </button>
                      </DataTableRowActions>
                    </DataTableTd>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </DataTableScroll>
      )}
    </SectionCard>
  );
}
