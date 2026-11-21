import { useState } from 'react';
import { X } from 'lucide-react';
import HostBackup from './HostBackup.jsx';
import HostBackupScheduler from './HostBackupScheduler.jsx';
import HostStorage from './HostStorage.jsx';
import HostNetworkBridges from './HostNetworkBridges.jsx';
import RecordError from '../shared/RecordError.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';

export default function HostMgmt() {
  const [bridgeError, setBridgeError] = useState(null);
  /* One notice for the page's settings cards, when a re-read of the settings failed. */
  const settingsRecord = useRecord(RECORD.SETTINGS);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5 space-y-5">
      {settingsRecord.data != null && <RecordError record={settingsRecord} what="settings" />}

      {bridgeError && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-status-stopped/30 bg-status-stopped-soft px-3 py-2 text-xs text-status-stopped">
          <span className="min-w-0 flex-1">{bridgeError}</span>
          <button
            type="button"
            onClick={() => setBridgeError(null)}
            className="shrink-0 rounded-sm p-2 lg:p-1 hover:bg-status-stopped-soft transition-colors duration-150"
            title="Dismiss"
            aria-label="Dismiss network bridge error"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <HostNetworkBridges onError={setBridgeError} />

      <HostStorage />

      <HostBackup />

      <HostBackupScheduler />
    </div>
  );
}
