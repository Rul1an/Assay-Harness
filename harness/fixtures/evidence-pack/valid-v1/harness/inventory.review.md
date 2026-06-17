# MCP Server Inventory (descriptive)

**Schema:** `assay.mcp_server_inventory.v0`
**Carrier:** `/tmp/ep-inputs/assay.mcp_server_inventory.v0.json`

> Descriptive reviewer context, not a gate. The Harness surfaces the observed inventory
> and its scanner coverage; it does not decide whether an inventory is acceptable, and it
> never reads a partial scan as proof that nothing else is there. Drift and approval over
> the inventory are a separate review step.

## Scanner coverage

| Source | Coverage |
| --- | --- |
| config:claude_desktop | `complete` |
| config:cursor | `not_scanned` |
| process_scan | `not_scanned` |
| network_scan | `unsupported` |

Absence claim: **not** supportable (at least one source is not complete); absence from this inventory is not absence from the environment

## Observed servers (1)

| Server | Source | Transport | Credentials (by name) | Observed |
| --- | --- | --- | --- | --- |
| claude_desktop-notes | claude_desktop_mcp_config | stdio | none | `observed` |

## Non-claims (carried from the carrier)

- absence from inventory is not absence from environment unless scanner coverage is complete

