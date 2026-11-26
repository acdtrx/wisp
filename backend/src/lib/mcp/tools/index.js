import { overviewTools } from './overviewTools.js';
import { containerTools } from './containerTools.js';
import { containerAgentTools } from './containerAgentTools.js';
import { vmTools } from './vmTools.js';
import { hostTools } from './hostTools.js';
import { jobTools } from './jobTools.js';

/**
 * Every MCP tool: { name, title, description, inputSchema, scope, handler }.
 * `scope` is the minimum token scope required ('read' | 'agent'), compared
 * with the token's in the scopes' one order (lib/apiTokenScopes.js).
 */
export const allTools = [...overviewTools, ...containerTools, ...containerAgentTools, ...vmTools, ...hostTools, ...jobTools];

{
  const names = new Set();
  for (const t of allTools) {
    if (names.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
    names.add(t.name);
  }
}
