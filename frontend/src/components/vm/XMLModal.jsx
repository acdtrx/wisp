import { useState, useEffect } from 'react';
import { Copy, Check, Loader2 } from 'lucide-react';
import Modal from '../shared/Modal.jsx';
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

  useEffect(() => {
    if (!open || !vmName) return;
    setLoading(true);
    setCopied(false);
    getVMXML(vmName)
      .then((data) => setXml(data.xml || ''))
      .catch((err) => setXml(`Failed to load XML: ${err?.message || 'unknown error'}`))
      .finally(() => setLoading(false));
  }, [open, vmName]);

  const handleCopy = () => {
    navigator.clipboard.writeText(xml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Domain XML — ${vmName}`}
      size="4xl"
      height="tall"
      bodyPadding="none"
      headerExtra={
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md border border-surface-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface transition-colors duration-150"
        >
          {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
        </button>
      }
    >
      <div className="h-full overflow-auto p-4">
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
    </Modal>
  );
}
