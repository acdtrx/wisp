import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { usePopover } from '../../lib/popover.js';

import { useSettingsStore } from '../../store/settingsStore.js';
import { useDiscoveryStore } from '../../store/discoveryStore.js';

/**
 * Server name in the top bar. When other Wisp servers are discovered on the
 * LAN (via the discovery SSE stream) it grows a chevron that opens a menu of
 * peers, each opening in a new tab. With no peers it renders the plain name.
 */

/**
 * The muted label under a peer's name shows where the link actually goes —
 * the advertised URL's hostname (e.g. a reverse-proxy domain), not the mDNS
 * SRV host, which may differ. Falls back to the SRV host if the URL is odd.
 */
function peerHostLabel(peer) {
  try {
    return new URL(peer.url).hostname;
  } catch {
    return peer.host;
  }
}
export default function ServerSwitcher() {
  const serverName = useSettingsStore((s) => s.settings?.serverName ?? 'My Server');
  const peers = useDiscoveryStore((s) => s.peers);
  const connect = useDiscoveryStore((s) => s.connect);
  const disconnect = useDiscoveryStore((s) => s.disconnect);

  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const popRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);
  const popStyle = usePopover(open && peers.length > 0, { anchorRef, popRef, onClose: close, align: 'start' });

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  if (peers.length === 0) {
    return <span className="text-sm text-text-muted">{serverName}</span>;
  }

  return (
    <div className="relative">
      <button
        ref={anchorRef}
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
      {open && createPortal(
        <div
          ref={popRef}
          role="menu"
          tabIndex={-1}
          style={popStyle}
          className="z-[60] min-w-56 overflow-y-auto rounded-md border border-surface-border bg-surface-card py-1 shadow-popover outline-hidden"
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
                {peerHostLabel(peer)}
                {peer.version ? ` · v${peer.version}` : ''}
              </span>
            </a>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
