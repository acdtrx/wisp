import { useEffect, useState } from 'react';
import { AlertTriangle, Plus, Unplug, Usb } from 'lucide-react';

import { attachUSBToVM, detachUSBFromVM } from '../../api/vms.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import { CONNECTION } from '../../store/streamStore.js';
import { useUsbStore } from '../../store/usbStore.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import GroupCard from '../shared/GroupCard.jsx';
import GroupItem from '../shared/GroupItem.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import RecordError from '../shared/RecordError.jsx';
import UsbAttachModal from '../shared/UsbAttachModal.jsx';

/** Attach and detach take the VM's lock: one at a time. */
const USB = 'usb';
const NO_DEVICES = [];
const idOf = (d) => `${d.vendorId}:${d.productId}`;

/**
 * The host's USB devices passed through to the VM: Attach (a picker of the host's
 * devices not yet attached; it closes as the attach starts) and Detach, at any time.
 * A device the host no longer has is shown so, and can still be detached.
 */
export default function VmUsbGroup({ config, busy, act }) {
  const hostDevices = useUsbStore((s) => s.data);
  const hostError = useUsbStore((s) => s.error);
  const hostDropped = useUsbStore((s) => s.connection === CONNECTION.DROPPED);
  const dismissHostError = useUsbStore((s) => s.dismissError);
  const connect = useUsbStore((s) => s.connect);
  const disconnect = useUsbStore((s) => s.disconnect);
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const attached = useRecord(RECORD.VM_USB, config.name);
  const [picking, setPicking] = useState(false);
  const host = hostDevices ?? NO_DEVICES;
  const attachedList = attached.data ?? NO_DEVICES;
  const attachedIds = new Set(attachedList.map(idOf));
  const available = host.filter((h) => !attachedIds.has(idOf(h)));
  const running = act.isBusy(USB);
  const reason = busy ?? (running ? 'another USB change is being saved' : undefined);
  const detachAbout = (d) => `Couldn't detach ${d.vendorId}:${d.productId}`;

  const attach = (vendorId, productId) => {
    setPicking(false);
    act.run(() => attachUSBToVM(config.name, vendorId, productId), { key: USB, about: `Couldn't attach ${vendorId}:${productId}` });
  };

  return (
    <GroupCard
      title="USB devices"
      actions={(
        <GroupAction
          icon={Plus}
          kindIcon={Usb}
          variant="add"
          label="Attach a USB device"
          reason={reason ?? (hostDevices == null ? 'the host’s devices are loading' : available.length === 0 ? 'no other device on the host' : undefined)}
          onClick={() => setPicking(true)}
        />
      )}
    >
      <ErrorBanner className="mb-2" error={hostError} onDismiss={hostDevices ? dismissHostError : undefined} />
      {hostDropped && <p className="py-1 text-xs text-text-muted" role="status">The host’s USB list is not connected; retrying…</p>}
      {attached.data != null && <RecordError record={attached} what="attached devices" className="mb-2" />}
      <RecordGate record={attached} what="attached devices">
        {() => (
          <>
            {attachedList.length === 0 && <p className="py-1 text-sm text-text-muted">None attached.</p>}
            {attachedList.map((d) => {
              const onHost = host.find((h) => idOf(h) === idOf(d));
              const missing = hostDevices != null && !onHost;
              return (
                <GroupItem
                  key={idOf(d)}
                  title={missing
                    ? <span className="inline-flex items-center gap-1.5 text-status-stopped"><AlertTriangle size={13} aria-hidden /> Not on the host now</span>
                    : (onHost?.name || 'USB device')}
                  detail={[idOf(d), onHost ? `bus ${onHost.bus}, device ${onHost.device}` : null].filter(Boolean).join(' · ')}
                  actions={(
                    <GroupAction
                      icon={Unplug}
                      variant="danger"
                      label={`Detach ${onHost?.name || idOf(d)}`}
                      reason={reason}
                      busy={running && act.aboutOf(USB) === detachAbout(d)}
                      onClick={() => act.run(() => detachUSBFromVM(config.name, d.vendorId, d.productId), { key: USB, about: detachAbout(d) })}
                    />
                  )}
                />
              );
            })}
          </>
        )}
      </RecordGate>
      <UsbAttachModal
        open={picking}
        onClose={() => setPicking(false)}
        devices={available}
        onAttach={attach}
        isBusy={() => false}
        anyBusy={running}
      />
    </GroupCard>
  );
}
