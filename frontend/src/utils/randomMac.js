/** Locally administered unicast MAC (same pattern as VM NICs in AdvancedSection). */
export function randomMac() {
  const b = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return `52:54:00:${b()}:${b()}:${b()}`;
}
