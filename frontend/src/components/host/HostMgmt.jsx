import { useState } from 'react';
import { X } from 'lucide-react';
import HostBackup from './HostBackup.jsx';
import HostStorage from './HostStorage.jsx';
import HostNetworkBridges from './HostNetworkBridges.jsx';

export default function HostMgmt() {
  const [bridgeError, setBridgeError] = useState(null);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
      {bridgeError && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-status-stopped">
          <span className="min-w-0 flex-1">{bridgeError}</span>
          <button
            type="button"
            onClick={() => setBridgeError(null)}
            className="shrink-0 rounded p-1 hover:bg-red-100 transition-colors duration-150"
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
    </div>
  );
}
