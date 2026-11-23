import { Plus } from 'lucide-react';

import Modal from './Modal.jsx';
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
import IconButton from './IconButton.jsx';

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {Array<{ bus: string, device: string, vendorId: string, productId: string, name: string }>} props.devices - Host devices not yet attached to the VM
 * @param {(vendorId: string, productId: string) => void | Promise<void>} props.onAttach
 * @param {(key: string) => boolean} props.isBusy - whether the attach of `${vendorId}:${productId}` is in flight
 * @param {boolean} props.anyBusy - an attach or detach is in flight (the VM's lock: the others wait)
 */
export default function UsbAttachModal({ open, onClose, devices, onAttach, isBusy, anyBusy }) {
  const list = Array.isArray(devices) ? devices : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Attach USB device"
      size="3xl"
      height="tall"
      bodyPadding="none"
    >
      <div className="px-4 py-4">
        <div className="rounded-card border border-surface-border bg-surface-card px-5 py-4">
          <DataTableScroll>
            <DataTable>
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
                  const loading = isBusy(key);
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
                          <IconButton
                            icon={Plus}
                            label={`Attach ${dev.name}`}
                            title="Attach"
                            variant="primary"
                            size="sm"
                            busy={loading}
                            disabled={anyBusy}
                            onClick={() => onAttach(dev.vendorId, dev.productId)}
                          />
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
    </Modal>
  );
}
