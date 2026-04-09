import { useState, useRef, useCallback, useEffect } from 'react';
import { useContainerStore } from '../../store/containerStore.js';
import ContainerConsoleToolbar from './ContainerConsoleToolbar.jsx';
import ContainerConsole from './ContainerConsole.jsx';

const RUNNING_STATE = 'running';

export default function ContainerConsolePanel({ containerName }) {
  const [consoleConnected, setConsoleConnected] = useState(false);
  const consoleViewportRef = useRef(null);
  const consoleApiRef = useRef(null);
  const prevStateRef = useRef(undefined);

  const state = useContainerStore((s) => s.containerConfig?.state);
  const isRunning = state === RUNNING_STATE;

  const handleConnect = useCallback(() => setConsoleConnected(true), []);
  const handleDisconnect = useCallback(() => setConsoleConnected(false), []);

  useEffect(() => {
    const wasRunning = prevStateRef.current === RUNNING_STATE;
    const nowRunning = state === RUNNING_STATE;
    if (nowRunning && prevStateRef.current != null && !wasRunning) {
      consoleApiRef.current?.connect?.();
    }
    prevStateRef.current = state;
  }, [state]);

  const handleFullscreen = useCallback(() => {
    if (consoleViewportRef.current?.requestFullscreen) {
      consoleViewportRef.current.requestFullscreen();
    }
  }, []);

  if (!isRunning) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-text-muted">
          Start the container to open a shell.
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ContainerConsoleToolbar
        onPaste={() => consoleApiRef.current?.paste?.()}
        onFullscreen={handleFullscreen}
        onDisconnect={() => consoleApiRef.current?.disconnect?.()}
        onReconnect={() => consoleApiRef.current?.connect?.()}
        connected={consoleConnected}
      />
      <div className="relative min-h-0 min-w-0 flex-1" style={{ minHeight: 200 }}>
        <div
          ref={consoleViewportRef}
          className="absolute inset-0 overflow-hidden rounded-b-md bg-[#1e293b] p-1"
        />
        <ContainerConsole
          containerName={containerName}
          isRunning={isRunning}
          viewportRef={consoleViewportRef}
          apiRef={consoleApiRef}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        />
      </div>
    </div>
  );
}
