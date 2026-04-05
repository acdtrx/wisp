import { useState, useEffect } from 'react';
import { Copy, Check, X, Loader2 } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { getVMXML } from '../../api/vms.js';

function highlightXml(xml) {
  if (!xml) return null;
  const parts = [];
  let key = 0;

  const lines = xml.split('\n');
  for (const line of lines) {
    const segments = [];
    let remaining = line;

    while (remaining.length > 0) {
      const tagMatch = remaining.match(/^(<\/?[\w:.-]+)/);
      if (tagMatch) {
        segments.push(<span key={key++} className="text-accent">{tagMatch[1]}</span>);
        remaining = remaining.slice(tagMatch[1].length);
        continue;
      }

      const attrMatch = remaining.match(/^(\s+[\w:.-]+=)/);
      if (attrMatch) {
        segments.push(<span key={key++} className="text-purple-600">{attrMatch[1]}</span>);
        remaining = remaining.slice(attrMatch[1].length);
        continue;
      }

      const strMatch = remaining.match(/^('[^']*'|"[^"]*")/);
      if (strMatch) {
        segments.push(<span key={key++} className="text-status-running">{strMatch[1]}</span>);
        remaining = remaining.slice(strMatch[1].length);
        continue;
      }

      const closeMatch = remaining.match(/^(\/?>)/);
      if (closeMatch) {
        segments.push(<span key={key++} className="text-accent">{closeMatch[1]}</span>);
        remaining = remaining.slice(closeMatch[1].length);
        continue;
      }

      const commentMatch = remaining.match(/^(<!--[\s\S]*?-->)/);
      if (commentMatch) {
        segments.push(<span key={key++} className="text-text-muted">{commentMatch[1]}</span>);
        remaining = remaining.slice(commentMatch[1].length);
        continue;
      }

      segments.push(remaining[0]);
      remaining = remaining.slice(1);
    }

    parts.push(<span key={key++}>{segments}</span>);
    parts.push('\n');
  }

  return parts;
}

export default function XMLModal({ open, vmName, onClose }) {
  const [xml, setXml] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (!open || !vmName) return;
    setLoading(true);
    setCopied(false);
    getVMXML(vmName)
      .then((data) => setXml(data.xml || ''))
      .catch(() => setXml('Failed to load XML'))
      .finally(() => setLoading(false));
  }, [open, vmName]);

  if (!open) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(xml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-card bg-surface-card shadow-lg" data-wisp-modal-root>
        <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Domain XML — {vmName}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 rounded-md border border-surface-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface transition-colors duration-150"
            >
              {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-text-muted" />
            </div>
          ) : (
            <pre className="text-xs leading-relaxed font-mono text-text-primary whitespace-pre overflow-x-auto">
              {highlightXml(xml)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
