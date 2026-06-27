/** Runner capability-surface shape guards. */

/**
 * Verify that a parsed capability-surface payload matches the
 * `RunnerCapabilitySurface` shape: every required category is present and
 * is an array whose elements are all strings.
 *
 * Returns `null` when the shape is valid, or a short reason string when it
 * is not. The reason is included in the corresponding
 * `CAPABILITY_SURFACE_SHAPE_INVALID` artifact_parse_error so callers see
 * which category failed and why. Schema-string and JSON-parse errors are
 * NOT this helper's responsibility — they are checked separately before
 * this function runs.
 *
 * This guard protects downstream Tier-2A diff code (`runner_compare.ts`)
 * from receiving non-array values that would crash `.filter()` or
 * non-string elements that would break set diffing.
 */
export function capabilitySurfaceShapeError(payload: Record<string, unknown>): string | null {
  const requiredArrays: readonly string[] = [
    "filesystem_paths",
    "network_endpoints",
    "process_execs",
    "mcp_tools",
    "policy_decisions",
  ];
  for (const field of requiredArrays) {
    const value = payload[field];
    if (value === undefined) {
      return `missing required array field "${field}"`;
    }
    if (!Array.isArray(value)) {
      return `field "${field}" must be an array (got ${typeof value})`;
    }
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== "string") {
        return `field "${field}[${i}]" must be a string (got ${typeof value[i]})`;
      }
    }
  }
  return null;
}
