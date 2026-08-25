const NIC_MODEL_OPTIONS = [
  { value: 'virtio', label: 'VirtIO' },
  { value: 'e1000', label: 'e1000' },
  { value: 'rtl8139', label: 'rtl8139' },
];

/**
 * NIC model picker (segmented control). Shared by the create-flow draft rows in
 * VmNetworkInterfacesSection and the Model field of NicEditorModal.
 */
export default function NicModelSegmentedControl({ value, onChange, disabled }) {
  return (
    <div className="flex h-8 min-w-[220px] max-w-[300px] rounded-lg border border-surface-border bg-surface p-0.5">
      {NIC_MODEL_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => !disabled && onChange(opt.value)}
          disabled={disabled}
          className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors duration-150 ${
            value === opt.value
              ? 'bg-surface-card text-text-primary shadow-xs'
              : 'text-text-secondary hover:text-text-primary'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
