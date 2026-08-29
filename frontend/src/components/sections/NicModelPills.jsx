import RadioPills from '../shared/RadioPills.jsx';

const NIC_MODEL_OPTIONS = [
  { value: 'virtio', label: 'VirtIO' },
  { value: 'e1000', label: 'e1000' },
  { value: 'rtl8139', label: 'rtl8139' },
];

/**
 * NIC model picker. Shared by the create-flow draft rows in
 * VmNetworkInterfacesSection and the Model field of NicEditorModal.
 */
export default function NicModelPills({ value, onChange, disabled }) {
  return <RadioPills options={NIC_MODEL_OPTIONS} value={value} onChange={onChange} disabled={disabled} />;
}
