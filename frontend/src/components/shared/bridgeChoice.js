/** The empty choice of a bridge picker: what the list is while it has none to offer. */
export function bridgeChoice(bridgesRecord) {
  if (bridgesRecord.status === 'loading') return 'Loading bridges…';
  if ((bridgesRecord.data ?? []).length === 0) return bridgesRecord.error ? 'Bridges unavailable' : 'No bridges';
  return 'Select…';
}
