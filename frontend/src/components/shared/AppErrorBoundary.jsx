import { Component } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';

import WispGlyph from './WispGlyph.jsx';

/**
 * Top-level render-error boundary. Without it any throw during render unmounts
 * the whole tree — a blank page, unrecoverable on an iOS home-screen launch
 * where there is no browser chrome to reload from. React already logs the
 * caught error to the console, so this only renders the recovery panel.
 */
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = error instanceof Error ? error.message : String(error);

    return (
      <div className="flex min-h-screen items-center justify-center bg-surface px-4">
        <div className="w-full max-w-sm">
          <div className="rounded-card bg-surface-card p-8 shadow-card border border-surface-border text-center">
            <WispGlyph size={32} className="mx-auto mb-4" />

            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-status-stopped-soft">
              <AlertTriangle size={22} className="text-status-stopped" />
            </div>

            <h1 className="font-display text-xl font-semibold text-text-primary">Something went wrong</h1>
            <p className="mt-2 text-sm text-text-secondary">
              Wisp hit an unexpected error while drawing this page. Reloading usually fixes it.
            </p>

            {message && (
              <p className="mt-3 break-words font-mono text-xs text-text-muted">{message}</p>
            )}

            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors duration-150"
            >
              <RefreshCw size={16} />
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
