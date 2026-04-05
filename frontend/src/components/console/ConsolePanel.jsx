import { useState, useRef, useCallback, useEffect } from 'react';
import { useVmStore } from '../../store/vmStore.js';
import ConsoleToolbar from './ConsoleToolbar.jsx';
import VNCConsole from './VNCConsole.jsx';

const RUNNING_STATES = ['running', 'blocked'];

export default function ConsolePanel({ vmName }) {
  const [consoleConnected, setConsoleConnected] = useState(false);
  const consoleViewportRef = useRef(null);
  const consoleApiRef = useRef(null);
  const prevVmStateRef = useRef(undefined);

  const vmState = useVmStore((s) => s.vmConfig?.state);

  const handleConnect = useCallback(() => setConsoleConnected(true), []);
  const handleDisconnect = useCallback(() => setConsoleConnected(false), []);

  // Reconnect console when VM transitions to running (e.g. user started it while on console tab)
  useEffect(() => {
    const isRunning = vmState != null && RUNNING_STATES.includes(vmState);
    const wasRunning = prevVmStateRef.current != null && RUNNING_STATES.includes(prevVmStateRef.current);
    if (isRunning && prevVmStateRef.current != null && !wasRunning) {
      consoleApiRef.current?.connect?.();
    }
    prevVmStateRef.current = vmState;
  }, [vmState]);

  const handleFullscreen = useCallback(() => {
    if (consoleViewportRef.current?.requestFullscreen) {
      consoleViewportRef.current.requestFullscreen();
    }
  }, []);

  return (
    <>
      <ConsoleToolbar
        onCtrlAltDel={() => consoleApiRef.current?.sendCtrlAltDel?.()}
        onPaste={() => consoleApiRef.current?.paste?.()}
        onFullscreen={handleFullscreen}
        onScreenshot={() => consoleApiRef.current?.screenshot?.()}
        onDisconnect={() => consoleApiRef.current?.disconnect?.()}
        onReconnect={() => consoleApiRef.current?.connect?.()}
        connected={consoleConnected}
      />
      <div
        ref={consoleViewportRef}
        className="min-h-0 flex-1 bg-[#1e293b]"
        style={{ minHeight: 200 }}
      />
      <VNCConsole
        vmName={vmName}
        viewportRef={consoleViewportRef}
        apiRef={consoleApiRef}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
      />
    </>
  );
}
