import { overviewTools } from './overviewTools.js';
import { containerTools } from './containerTools.js';
import { vmTools } from './vmTools.js';
import { hostTools } from './hostTools.js';

/**
 * Every MCP tool: { name, title, description, inputSchema, scope, handler }.
 * `scope` is the minimum token scope required ('read' | 'admin'); an admin
 * token can call everything.
 */
export const allTools = [...overviewTools, ...containerTools, ...vmTools, ...hostTools];

{
  const names = new Set();
  for (const t of allTools) {
    if (names.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
    names.add(t.name);
  }
}
