import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { useSettingsStore } from '../../store/settingsStore.js';
import { useDiscoveryStore } from '../../store/discoveryStore.js';

/**
 * Server name in the top bar. When other Wisp servers are discovered on the
 * LAN (via the discovery SSE stream) it grows a chevron that opens a menu of
 * peers, each opening in a new tab. With no peers it renders the plain name.
 */
export default function ServerSwitcher() {
  const serverName = useSettingsStore((s) => s.settings?.serverName ?? 'My Server');
  const peers = useDiscoveryStore((s) => s.peers);
  const connect = useDiscoveryStore((s) => s.connect);
  const disconnect = useDiscoveryStore((s) => s.disconnect);

  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        close();
      }
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  if (peers.length === 0) {
    return <span className="text-sm text-text-muted">{serverName}</span>;
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md text-sm text-text-muted hover:text-text-primary transition-colors duration-150"
        title="Other Wisp servers on this network"
        aria-label="Other Wisp servers on this network"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {serverName}
        <ChevronDown size={12} className="text-text-muted" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-md border border-surface-border bg-surface-card py-1 shadow-lg"
        >
          {peers.map((peer) => (
            <a
              key={peer.host || peer.name}
              role="menuitem"
              href={peer.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
              className="flex w-full flex-col px-3 py-2 hover:bg-surface"
            >
              <span className="text-sm text-text-primary">{peer.name}</span>
              <span className="text-[10px] text-text-muted">
                {peer.host}
                {peer.version ? ` · v${peer.version}` : ''}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
