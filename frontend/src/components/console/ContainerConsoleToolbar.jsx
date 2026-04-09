import {
  ClipboardPaste, Maximize2, Unplug, RefreshCw,
} from 'lucide-react';

export default function ContainerConsoleToolbar({
  onPaste,
  onFullscreen,
  onDisconnect,
  onReconnect,
  connected,
}) {
  const baseBtn = 'flex items-center gap-1.5 rounded-md border border-surface-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-card px-4 py-2">
      <button
        type="button"
        onClick={onPaste}
        disabled={!connected}
        className={baseBtn}
        title="Paste from clipboard"
      >
        <ClipboardPaste size={14} />
        Paste
      </button>

      <button
        type="button"
        onClick={onFullscreen}
        className={baseBtn}
        title="Fullscreen terminal"
      >
        <Maximize2 size={14} />
        Fullscreen
      </button>

      <div className="h-4 w-px bg-surface-border" />

      {connected ? (
        <button type="button" onClick={onDisconnect} className={baseBtn} title="Disconnect">
          <Unplug size={14} />
          Disconnect
        </button>
      ) : (
        <button type="button" onClick={onReconnect} className={baseBtn} title="Reconnect">
          <RefreshCw size={14} />
          Reconnect
        </button>
      )}
    </div>
  );
}
