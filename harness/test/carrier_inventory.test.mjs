import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MCP_SERVER_INVENTORY_SCHEMA,
  validateMcpInventory,
  buildMcpInventoryReport,
  loadMcpInventoryReport,
  formatMcpInventoryMarkdown,
} from "../dist/carrier_inventory.js";
import { getCarrierAdapter } from "../dist/carrier_registry.js";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/mcp-server-inventory/${name}`, import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("schema constant + registry resolves the adapter", () => {
  assert.equal(MCP_SERVER_INVENTORY_SCHEMA, "assay.mcp_server_inventory.v0");
  assert.ok(getCarrierAdapter(MCP_SERVER_INVENTORY_SCHEMA));
});

test("real golden validates; mixed coverage does not support an absence claim", () => {
  const r = buildMcpInventoryReport(fixture("golden.inventory.json"));
  assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
  assert.equal(r.server_count, 2);
  assert.equal(r.supports_absence_claim, false);
});

test("complete coverage supports an absence claim", () => {
  const r = buildMcpInventoryReport(fixture("complete-coverage.inventory.json"));
  assert.equal(r.validation.valid, true);
  assert.equal(r.supports_absence_claim, true);
});

test("validate rejects a wrong/unknown schema id", () => {
  const v = validateMcpInventory({ schema: "assay.mcp_server_inventory.v1" });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_SCHEMA_MISMATCH");
});

test("validate rejects an unknown coverage state (forward-compat guard)", () => {
  const v = validateMcpInventory({
    schema: MCP_SERVER_INVENTORY_SCHEMA,
    scanner_coverage: { config_sources: { x: "totally_bogus" }, process_scan: "complete", network_scan: "complete" },
    servers: [],
    non_claims: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CARRIER_COVERAGE_STATE_UNKNOWN"));
});

test("markdown surfaces coverage + servers + absence-claim honesty, never alarmist wording", () => {
  const md = formatMcpInventoryMarkdown(buildMcpInventoryReport(fixture("golden.inventory.json")));
  assert.match(md, /MCP Server Inventory/);
  assert.match(md, /Absence claim:/);
  assert.match(md, /github-tools/);
  for (const banned of [/\bapproved\b/i, /\bcompliant\b/i, /attack/i]) {
    assert.doesNotMatch(md, banned);
  }
});

test("markdown escapes a pipe in a producer-supplied server field", () => {
  const report = {
    carrier_path: "x",
    validation: {
      valid: true,
      errors: [],
      carrier: {
        schema: MCP_SERVER_INVENTORY_SCHEMA,
        scanner_coverage: { config_sources: {}, process_scan: "complete", network_scan: "complete" },
        servers: [
          {
            server_id: "a|b", source: "s", transport: "stdio",
            command_digest: "sha256:x", args_digest: "sha256:y",
            credential_indicators: [], observed_state: "observed",
          },
        ],
        non_claims: [],
      },
    },
    server_count: 1,
    supports_absence_claim: true,
  };
  const md = formatMcpInventoryMarkdown(report);
  assert.ok(md.includes("a\\|b"), "a pipe in server_id must be escaped to not break the table");
});

test("loadMcpInventoryReport reports not_found for a missing path", () => {
  assert.equal(loadMcpInventoryReport("/nonexistent/x.json").not_found, true);
});

function runCli(...cliArgs) {
  return spawnSync(process.execPath, [CLI, "carrier", "inventory", ...cliArgs], { encoding: "utf8" });
}

test("CLI: any valid inventory -> 0 (descriptive); wrong-schema -> 3; missing -> 2; bad-format -> 2", () => {
  assert.equal(runCli("--carrier", fixture("golden.inventory.json")).status, 0);
  assert.equal(runCli("--carrier", fixture("complete-coverage.inventory.json")).status, 0);
  assert.equal(runCli("--carrier", fixture("wrong-schema.inventory.json")).status, 3);
  assert.equal(runCli("--carrier", "/nonexistent/x.json").status, 2);
  assert.equal(runCli("--carrier", fixture("golden.inventory.json"), "--format", "xml").status, 2);
});

test("CLI: --format json emits only parseable JSON on stdout (no summary leak)", () => {
  const r = runCli("--carrier", fixture("golden.inventory.json"), "--format", "json");
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.validation.carrier.schema, MCP_SERVER_INVENTORY_SCHEMA);
});
