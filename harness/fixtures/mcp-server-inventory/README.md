# MCP server inventory fixtures

Test fixtures for the `carrier inventory` descriptive projector. Each is an
`assay.mcp_server_inventory.v0` carrier (producer: `Rul1an/assay`,
`crates/assay-core/src/discovery/inventory_carrier.rs`, `assay mcp inventory`). The
Harness validates the frozen shape and projects a reviewer-facing Markdown summary.

`carrier inventory` is **descriptive / non-gating**: a valid inventory exits 0
regardless of contents; only a malformed / wrong-schema / unknown-coverage-state
carrier is a contract error (exit 3). Drift and approval over the inventory are a
separate review step.

| Fixture | Source | Notes |
|---|---|---|
| `golden.inventory.json` | the real producer golden, vendored verbatim | mixed coverage (one source `not_scanned`, `process_scan=unavailable`, `network_scan=unsupported`), so it does **not** support an absence claim |
| `complete-coverage.inventory.json` | synthetic, all sources `complete` | supports an absence claim (every scanned source complete) |
| `wrong-schema.inventory.json` | synthetic, `v1` schema id with no adapter | contract error (exit 3) |

Coverage honesty: only a `complete` scan supports an absence claim. The projection
states which sources are complete and whether the inventory can support "nothing
else is there"; it never converts a partial scan into that claim.
