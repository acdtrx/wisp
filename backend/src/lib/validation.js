/**
 * The value schemas the routes and the MCP tools both check input against
 * (lib/schemaValidation.js): one rule for a VM name, a container name and a
 * run id, wherever one arrives.
 */

/*
 * A workload name is a path segment under its directory (docs/specs/VM-MANAGEMENT.md,
 * docs/specs/CONTAINERS.md): letters, digits, dots, hyphens and underscores,
 * a leading letter or digit (so never `.` or `..`), no `..` anywhere, used
 * verbatim (never trimmed, so surrounding whitespace is refused).
 */
const WORKLOAD_NAME_PATTERN = '^(?!.*\\.\\.)[a-zA-Z0-9][a-zA-Z0-9._-]*$';

export const vmNameSchema = { type: 'string', maxLength: 128, pattern: WORKLOAD_NAME_PATTERN };

export const containerNameSchema = { type: 'string', maxLength: 63, pattern: WORKLOAD_NAME_PATTERN };

/**
 * The host bridge a container joins, or null: a network interface name as the
 * privileged helpers check it (backend/scripts/wisp-helper-lib.sh, IFACE_RE).
 */
export const containerBridgeSchema = { type: ['string', 'null'], pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$' };

/** A container run's id, as the run log files are named (`2026-10-16T18-34-18-915Z`). */
export const runIdSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$' };
