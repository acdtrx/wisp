/**
 * An API token's scopes, in one order: each holds the ones before it
 * (docs/specs/AUTH.md → Scopes). A route's level and an MCP tool's scope are
 * compared with the token's through `scopeCovers`; nothing keeps a list of
 * permissions per token.
 */
export const API_TOKEN_SCOPES = Object.freeze(['read', 'agent', 'admin']);

/** Whether a token of `scope` may do what `needed` asks. */
export function scopeCovers(scope, needed) {
  const held = API_TOKEN_SCOPES.indexOf(scope);
  const need = API_TOKEN_SCOPES.indexOf(needed);
  return held >= 0 && need >= 0 && held >= need;
}
