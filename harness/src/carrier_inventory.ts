/**
 * Descriptive carrier projector — `assay.mcp_server_inventory.v0` (Tier-2B).
 *
 * Consumer-not-owner. The producer (`Rul1an/assay`, `crates/assay-core/src/discovery/inventory_carrier.rs`,
 * `assay mcp inventory`) emits a coverage-honest projection of discovered MCP servers: per-source
 * scanner coverage, the observed servers (command/args hashed, credentials flagged by name only), and
 * the absence-claim non-claim. The Harness validates the frozen shape and projects a reviewer-facing
 * Markdown summary.
 *
 * DESCRIPTIVE / NON-GATING: this verb describes the inventory for review; it does not gate CI on a
 * pass/fail verdict. A valid inventory exits 0 regardless of contents; only a malformed / wrong-schema /
 * unknown-coverage-state carrier is a contract error (exit 3). Drift / approval decisions over the
 * inventory (e.g. an unexpected server) are the private Plimsoll consumer's job, not the Harness's.
 *
 * Coverage honesty is surfaced, never decided: only a `complete` scan supports an absence claim, so the
 * projection states which sources are complete and whether the inventory can support "nothing else is
 * there". It never converts a partial scan into that claim.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MCP_SERVER_INVENTORY_SCHEMA = "assay.mcp_server_inventory.v0";

/** Frozen coverage states (producer `CoverageState`); only `complete` supports an absence claim. */
export const KNOWN_COVERAGE_STATES: readonly string[] = [
  "complete",
  "partial",
  "not_scanned",
  "unavailable",
  "unsupported",
];

export interface InventoryServer {
  server_id: string;
  source: string;
  transport: string;
  command_digest: string;
  args_digest: string;
  credential_indicators: string[];
  observed_state: string;
}

export interface McpInventoryCarrier {
  schema: string;
  scanner_coverage: {
    config_sources: Record<string, string>;
    process_scan: string;
    network_scan: string;
  };
  servers: InventoryServer[];
  non_claims: string[];
}

export interface CarrierValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface McpInventoryValidation {
  valid: boolean;
  errors: CarrierValidationError[];
  carrier?: McpInventoryCarrier;
}

export interface McpInventoryReport {
  carrier_path: string;
  validation: McpInventoryValidation;
  server_count: number;
  /** True iff every coverage value is `complete` (so an absence claim is supportable). Descriptive. */
  supports_absence_claim: boolean;
}

export class McpInventoryProjectionError extends Error {
  readonly kind: "ci_formatter";
  constructor(message: string) {
    super(message);
    this.name = "McpInventoryProjectionError";
    this.kind = "ci_formatter";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function isKnownCoverage(value: unknown): value is string {
  return typeof value === "string" && KNOWN_COVERAGE_STATES.includes(value);
}

export function validateMcpInventory(raw: unknown): McpInventoryValidation {
  const errors: CarrierValidationError[] = [];

  if (!isRecord(raw)) {
    return {
      valid: false,
      errors: [{ code: "CARRIER_NOT_OBJECT", message: "mcp-inventory carrier must be a JSON object" }],
    };
  }
  if (raw.schema !== MCP_SERVER_INVENTORY_SCHEMA) {
    return {
      valid: false,
      errors: [
        {
          code: "CARRIER_SCHEMA_MISMATCH",
          message: `Expected schema ${MCP_SERVER_INVENTORY_SCHEMA}; got ${
            raw.schema === undefined ? "(missing)" : JSON.stringify(raw.schema)
          }`,
          path: "schema",
        },
      ],
    };
  }

  if (!isRecord(raw.scanner_coverage)) {
    errors.push({ code: "CARRIER_COVERAGE_INVALID", message: "scanner_coverage must be an object", path: "scanner_coverage" });
  } else {
    const cov = raw.scanner_coverage;
    if (!isRecord(cov.config_sources)) {
      errors.push({ code: "CARRIER_COVERAGE_INVALID", message: "scanner_coverage.config_sources must be an object", path: "scanner_coverage.config_sources" });
    } else {
      for (const [name, state] of Object.entries(cov.config_sources)) {
        if (!isKnownCoverage(state)) {
          errors.push({
            code: "CARRIER_COVERAGE_STATE_UNKNOWN",
            message: `scanner_coverage.config_sources.${name} must be a known coverage state (${JSON.stringify(KNOWN_COVERAGE_STATES)}); got ${JSON.stringify(state)}`,
            path: `scanner_coverage.config_sources.${name}`,
          });
        }
      }
    }
    for (const k of ["process_scan", "network_scan"] as const) {
      if (!isKnownCoverage(cov[k])) {
        errors.push({
          code: "CARRIER_COVERAGE_STATE_UNKNOWN",
          message: `scanner_coverage.${k} must be a known coverage state; got ${JSON.stringify(cov[k])}`,
          path: `scanner_coverage.${k}`,
        });
      }
    }
  }

  if (!Array.isArray(raw.servers)) {
    errors.push({ code: "CARRIER_SERVERS_INVALID", message: "servers must be an array", path: "servers" });
  } else {
    raw.servers.forEach((s: unknown, i: number) => {
      const path = `servers[${i}]`;
      if (!isRecord(s)) {
        errors.push({ code: "CARRIER_SERVER_SHAPE_INVALID", message: `${path} must be an object`, path });
        return;
      }
      for (const k of ["server_id", "source", "transport", "command_digest", "args_digest", "observed_state"] as const) {
        if (!isNonEmptyString(s[k])) {
          errors.push({ code: "CARRIER_SERVER_FIELD_INVALID", message: `${path}.${k} must be a non-empty string`, path: `${path}.${k}` });
        }
      }
      if (!isStringArray(s.credential_indicators)) {
        errors.push({ code: "CARRIER_SERVER_FIELD_INVALID", message: `${path}.credential_indicators must be an array of strings`, path: `${path}.credential_indicators` });
      }
    });
  }

  if (!isStringArray(raw.non_claims)) {
    errors.push({ code: "CARRIER_NON_CLAIMS_INVALID", message: "non_claims must be an array of strings", path: "non_claims" });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors, carrier: raw as unknown as McpInventoryCarrier };
}

export function buildMcpInventoryReport(carrierPath: string): McpInventoryReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(carrierPath, "utf8"));
  } catch (err) {
    return {
      carrier_path: carrierPath,
      validation: {
        valid: false,
        errors: [
          {
            code: "CARRIER_NOT_JSON",
            message: `${carrierPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      },
      server_count: 0,
      supports_absence_claim: false,
    };
  }

  const validation = validateMcpInventory(parsed);
  if (!validation.valid || !validation.carrier) {
    return { carrier_path: carrierPath, validation, server_count: 0, supports_absence_claim: false };
  }

  const c = validation.carrier;
  const coverageValues = [
    ...Object.values(c.scanner_coverage.config_sources),
    c.scanner_coverage.process_scan,
    c.scanner_coverage.network_scan,
  ];
  const supports_absence_claim = coverageValues.length > 0 && coverageValues.every((v) => v === "complete");
  return {
    carrier_path: carrierPath,
    validation,
    server_count: c.servers.length,
    supports_absence_claim,
  };
}

export interface McpInventoryLoadResult {
  ok: boolean;
  not_found?: boolean;
  report?: McpInventoryReport;
}

export function loadMcpInventoryReport(carrierPath: string): McpInventoryLoadResult {
  if (!carrierPath || !existsSync(carrierPath)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, report: buildMcpInventoryReport(carrierPath) };
}

export function formatMcpInventorySummary(report: McpInventoryReport): string {
  const status = report.validation.valid ? "DESCRIBED" : "MCP-INVENTORY CARRIER INVALID";
  return [
    "[carrier-inventory] schema: assay.mcp_server_inventory.v0",
    `[carrier-inventory] status: ${status}`,
    `[carrier-inventory] servers: ${report.server_count}`,
    `[carrier-inventory] supports_absence_claim: ${report.supports_absence_claim}`,
    `[carrier-inventory] artifact: ${report.carrier_path}`,
  ].join("\n");
}

export function formatMcpInventoryMarkdown(report: McpInventoryReport): string {
  const lines: string[] = [];
  lines.push("# MCP Server Inventory (descriptive)");
  lines.push("");
  lines.push(`**Schema:** \`${MCP_SERVER_INVENTORY_SCHEMA}\``);
  lines.push(`**Carrier:** \`${report.carrier_path}\``);
  lines.push("");
  lines.push("> Descriptive reviewer context, not a gate. The Harness surfaces the observed inventory");
  lines.push("> and its scanner coverage; it does not decide whether an inventory is acceptable, and it");
  lines.push("> never reads a partial scan as proof that nothing else is there. Drift and approval over");
  lines.push("> the inventory are a separate review step.");
  lines.push("");

  if (!report.validation.valid) {
    lines.push("## Carrier Validation Errors");
    lines.push("");
    for (const e of report.validation.errors) {
      lines.push(`- \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
    }
    lines.push("");
    return lines.join("\n") + "\n";
  }

  const c = report.validation.carrier as McpInventoryCarrier;
  lines.push("## Scanner coverage");
  lines.push("");
  lines.push("| Source | Coverage |");
  lines.push("| --- | --- |");
  for (const [name, state] of Object.entries(c.scanner_coverage.config_sources)) {
    lines.push(`| config:${name} | \`${state}\` |`);
  }
  lines.push(`| process_scan | \`${c.scanner_coverage.process_scan}\` |`);
  lines.push(`| network_scan | \`${c.scanner_coverage.network_scan}\` |`);
  lines.push("");
  lines.push(
    `Absence claim: ${report.supports_absence_claim ? "supportable (all scanned sources complete)" : "**not** supportable (at least one source is not complete); absence from this inventory is not absence from the environment"}`,
  );
  lines.push("");

  lines.push(`## Observed servers (${report.server_count})`);
  lines.push("");
  if (report.server_count > 0) {
    lines.push("| Server | Source | Transport | Credentials (by name) | Observed |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const s of c.servers) {
      const creds = s.credential_indicators.length > 0 ? s.credential_indicators.join(", ") : "none";
      lines.push(`| ${s.server_id} | ${s.source} | ${s.transport} | ${creds} | \`${s.observed_state}\` |`);
    }
    lines.push("");
  }

  if (c.non_claims.length > 0) {
    lines.push("## Non-claims (carried from the carrier)");
    lines.push("");
    for (const nc of c.non_claims) lines.push(`- ${nc}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function writeArtifact(path: string, content: string, label: string): void {
  try {
    const dir = dirname(path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, "utf8");
  } catch (err) {
    throw new McpInventoryProjectionError(
      `failed to write ${label} projection to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Descriptive projection: Markdown reviewer context only (no gating JUnit/SARIF). */
export function writeMcpInventoryProjections(report: McpInventoryReport, outDir: string): void {
  writeArtifact(`${outDir}/mcp-server-inventory.md`, formatMcpInventoryMarkdown(report), "Markdown");
}
