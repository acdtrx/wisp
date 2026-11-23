import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

import { usePopover } from '../../lib/popover.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useDiscoveryStore } from '../../store/discoveryStore.js';
import Button from '../shared/Button.jsx';

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
    return peer.host; // an advertised URL that is no URL: the SRV host (above)
  }
}
export default function ServerSwitcher() {
  const serverName = useRecord(RECORD.SETTINGS).data?.serverName ?? 'My Server';
  const peers = useDiscoveryStore((s) => s.data);
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
      <Button
        ref={anchorRef}
        variant="ghost"
        iconEnd={ChevronDown}
        title="Other Wisp servers on this network"
        aria-label="Other Wisp servers on this network"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {serverName}
      </Button>
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
