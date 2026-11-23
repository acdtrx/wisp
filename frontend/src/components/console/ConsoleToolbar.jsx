import {
  Power, ClipboardPaste, Maximize2, Camera, Unplug, RefreshCw,
} from 'lucide-react';

import Button from '../shared/Button.jsx';

export default function ConsoleToolbar({
  onCtrlAltDel,
  onPaste,
  onFullscreen,
  onScreenshot,
  onDisconnect,
  onReconnect,
  connected,
}) {

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-card px-4 py-2">
      <Button icon={Power} title="Send Ctrl+Alt+Del" onClick={onCtrlAltDel} disabled={!connected}>Ctrl+Alt+Del</Button>
      <Button icon={ClipboardPaste} title="Paste from clipboard" onClick={onPaste} disabled={!connected}>Paste</Button>
      <Button icon={Camera} title="Screenshot" onClick={onScreenshot} disabled={!connected}>Screenshot</Button>

      <div className="h-4 w-px bg-surface-border" />

      <Button icon={Maximize2} title="Fullscreen viewport" onClick={onFullscreen}>Fullscreen</Button>

      <div className="h-4 w-px bg-surface-border" />

      {connected ? (
        <Button icon={Unplug} title="Disconnect" onClick={onDisconnect}>Disconnect</Button>
      ) : (
        <Button icon={RefreshCw} title="Reconnect" onClick={onReconnect}>Reconnect</Button>
      )}
    </div>
  );
}
