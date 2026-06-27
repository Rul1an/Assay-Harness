/**
 * Conformance carrier gate — `assay.supply_chain_conformance.v0` adapter.
 *
 * Consumer-not-owner. The producer (`Rul1an/assay`, `crates/assay-registry`)
 * defines the carrier and computes `policy_result`. The Harness validates the
 * carrier's frozen v0 shape, gates CI on the PRODUCER's self-reported
 * `policy_result`, and projects the carrier into reviewer Markdown / JUnit /
 * SARIF. It does NOT introduce its own policy (no "require SLSA L2", no "require
 * Rekor", no threshold tuning), and it NEVER converts a passing carrier into
 * approval, certification, compliance, provider trust, runtime truth, or full
 * safety — that review stays with the private Plimsoll consumer.
 *
 * Gate (carrier-local, producer-owned):
 *   policy_result == "pass"        -> clean        (CLI exit 0)
 *   policy_result == "fail"        -> not clean     (CLI exit 6, regression)
 *   policy_result == "incomplete"  -> not clean     (CLI exit 6, regression) [incomplete is never clean]
 *   malformed JSON / wrong schema / unknown status / unknown policy_result
 *                                  -> contract error (CLI exit 3, artifact_contract)
 *
 * Append-only v0: the producer may add dimensions under `checks.*` (MCP04a-3.4
 * added the Sigstore-keyless ones: cert_chain, identity, dsse_pae,
 * timestamp_freshness, consistency, witnessing). This adapter validates that
 * every dimension VALUE is a known `CheckStatus` and projects whatever keys are
 * present; it does not hard-code the dimension key set. An unknown STATUS value
 * is rejected (forward-compat guard: an uninterpretable status is never read as
 * clean). Dimension-key drift detection is a separate slice (contract-drift).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatSupplyChainJUnit, formatSupplyChainSarif } from "./carrier_supply_chain_projections.js";

// ---------------------------------------------------------------------------
// Constants (pinned to Rul1an/assay@v3.27.0 producer contract)
// ---------------------------------------------------------------------------

export const SUPPLY_CHAIN_CONFORMANCE_SCHEMA = "assay.supply_chain_conformance.v0";

/**
 * Frozen `CheckStatus` value set, mirrored from
 * `crates/assay-registry/src/supply_chain.rs` (`#[serde(rename_all = "snake_case")]`).
 * Append-only on the producer side; an unknown status here means the carrier is
 * newer than this adapter and must not be read as clean.
 */
export const KNOWN_CHECK_STATUSES: readonly string[] = [
  "verified",
  "failed",
  "not_present",
  "not_applicable",
  "unsupported_format",
  "trust_root_unavailable",
  "online_required",
  "policy_not_satisfied",
  "subject_digest_mismatch",
  "identity_mismatch",
  "not_checked",
];

/** Statuses that record an active verification failure (a check that did not hold). */
const BLOCKING_STATUSES: readonly string[] = [
  "failed",
  "subject_digest_mismatch",
  "identity_mismatch",
  "policy_not_satisfied",
];

/** Statuses that are unresolved rather than failed (absent / present-but-unverifiable / deferred). */
const PENDING_STATUSES: readonly string[] = [
  "not_present",
  "unsupported_format",
  "trust_root_unavailable",
  "online_required",
  "not_checked",
];

/** Frozen `PolicyResult` value set (`crates/assay-registry` `PolicyResult`, snake_case). */
export const KNOWN_POLICY_RESULTS: readonly string[] = ["pass", "fail", "incomplete"];

/** The three frozen `checks` groups. New dimensions are added inside these groups. */
const REQUIRED_CHECK_GROUPS: readonly string[] = ["integrity", "provenance", "pinning"];

// ---------------------------------------------------------------------------
// Types — mirror the carrier v0 shape
// ---------------------------------------------------------------------------

export interface SupplyChainSubject {
  name: string;
  version: string;
  digest: string;
}

export interface SupplyChainCarrier {
  schema: string;
  subject: SupplyChainSubject;
  checks: Record<string, Record<string, string>>;
  declared: { required_slsa_build_level: string };
  verified: { slsa_build_level: string };
  policy_result: string;
  coverage: { sources_checked: string[]; limits: string[] };
  non_claims: string[];
}

export type DimensionClass = "verified" | "blocking" | "pending" | "not_applicable";

export interface DimensionStatus {
  group: string;
  name: string;
  status: string;
  class: DimensionClass;
}

export interface CarrierValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface SupplyChainValidation {
  valid: boolean;
  errors: CarrierValidationError[];
  carrier?: SupplyChainCarrier;
}

export interface SupplyChainReport {
  carrier_path: string;
  validation: SupplyChainValidation;
  /** Producer `policy_result`, set only when the carrier validated. */
  policy_result?: string;
  /** `true` iff `policy_result === "pass"`. The CLI maps `!passed` to exit 6. */
  passed: boolean;
  /** Flattened dimension list across the `checks` groups, for projection. */
  dimensions: DimensionStatus[];
  counts: { verified: number; blocking: number; pending: number; not_applicable: number };
}

/** Thrown only when writing a projection artifact fails (CLI maps to ci_formatter, exit 7). */
export class SupplyChainProjectionError extends Error {
  readonly kind: "ci_formatter";
  constructor(message: string) {
    super(message);
    this.name = "SupplyChainProjectionError";
    this.kind = "ci_formatter";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

export function classifyStatus(status: string): DimensionClass {
  if (status === "verified") return "verified";
  if (status === "not_applicable") return "not_applicable";
  if (BLOCKING_STATUSES.includes(status)) return "blocking";
  return "pending";
}

/**
 * Validate a parsed carrier payload against the frozen v0 shape. Returns a
 * structured result with `errors[]` and the parsed carrier (only when
 * `valid === true`). Never throws on structurally invalid input.
 */
export function validateSupplyChainConformance(raw: unknown): SupplyChainValidation {
  const errors: CarrierValidationError[] = [];

  if (!isRecord(raw)) {
    return {
      valid: false,
      errors: [{ code: "CARRIER_NOT_OBJECT", message: "supply-chain carrier must be a JSON object" }],
    };
  }

  if (raw.schema !== SUPPLY_CHAIN_CONFORMANCE_SCHEMA) {
    return {
      valid: false,
      errors: [
        {
          code: "CARRIER_SCHEMA_MISMATCH",
          message: `Expected schema ${SUPPLY_CHAIN_CONFORMANCE_SCHEMA}; got ${
            raw.schema === undefined ? "(missing)" : JSON.stringify(raw.schema)
          }`,
          path: "schema",
        },
      ],
    };
  }

  // subject
  if (!isRecord(raw.subject)) {
    errors.push({ code: "CARRIER_SUBJECT_INVALID", message: "subject must be an object", path: "subject" });
  } else {
    for (const k of ["name", "version", "digest"] as const) {
      if (!isNonEmptyString(raw.subject[k])) {
        errors.push({
          code: "CARRIER_SUBJECT_FIELD_INVALID",
          message: `subject.${k} must be a non-empty string`,
          path: `subject.${k}`,
        });
      }
    }
  }

  // checks: the three frozen groups must be present; every value in every group
  // must be a known CheckStatus (append-only: extra dimension keys are tolerated,
  // unknown status values are not).
  if (!isRecord(raw.checks)) {
    errors.push({ code: "CARRIER_CHECKS_INVALID", message: "checks must be an object", path: "checks" });
  } else {
    for (const group of REQUIRED_CHECK_GROUPS) {
      if (!isRecord(raw.checks[group])) {
        errors.push({
          code: "CARRIER_CHECK_GROUP_MISSING",
          message: `checks.${group} must be an object`,
          path: `checks.${group}`,
        });
      }
    }
    for (const [group, dims] of Object.entries(raw.checks)) {
      if (!isRecord(dims)) {
        errors.push({
          code: "CARRIER_CHECK_GROUP_INVALID",
          message: `checks.${group} must be an object`,
          path: `checks.${group}`,
        });
        continue;
      }
      for (const [name, status] of Object.entries(dims)) {
        if (typeof status !== "string" || !KNOWN_CHECK_STATUSES.includes(status)) {
          errors.push({
            code: "CARRIER_STATUS_UNKNOWN",
            message: `checks.${group}.${name} must be a known CheckStatus (${JSON.stringify(
              KNOWN_CHECK_STATUSES,
            )}); got ${JSON.stringify(status)}`,
            path: `checks.${group}.${name}`,
          });
        }
      }
    }
  }

  // declared / verified SLSA levels
  if (!isRecord(raw.declared) || !isNonEmptyString(raw.declared.required_slsa_build_level)) {
    errors.push({
      code: "CARRIER_DECLARED_INVALID",
      message: "declared.required_slsa_build_level must be a non-empty string",
      path: "declared.required_slsa_build_level",
    });
  }
  if (!isRecord(raw.verified) || !isNonEmptyString(raw.verified.slsa_build_level)) {
    errors.push({
      code: "CARRIER_VERIFIED_INVALID",
      message: "verified.slsa_build_level must be a non-empty string",
      path: "verified.slsa_build_level",
    });
  }

  // policy_result: frozen enum, unknown -> not clean (contract error)
  if (typeof raw.policy_result !== "string" || !KNOWN_POLICY_RESULTS.includes(raw.policy_result)) {
    errors.push({
      code: "CARRIER_POLICY_RESULT_UNKNOWN",
      message: `policy_result must be one of ${JSON.stringify(KNOWN_POLICY_RESULTS)}; got ${JSON.stringify(
        raw.policy_result,
      )}`,
      path: "policy_result",
    });
  }

  // coverage
  if (!isRecord(raw.coverage)) {
    errors.push({ code: "CARRIER_COVERAGE_INVALID", message: "coverage must be an object", path: "coverage" });
  } else {
    if (!isStringArray(raw.coverage.sources_checked)) {
      errors.push({
        code: "CARRIER_COVERAGE_INVALID",
        message: "coverage.sources_checked must be an array of strings",
        path: "coverage.sources_checked",
      });
    }
    if (!isStringArray(raw.coverage.limits)) {
      errors.push({
        code: "CARRIER_COVERAGE_INVALID",
        message: "coverage.limits must be an array of strings",
        path: "coverage.limits",
      });
    }
  }

  // non_claims
  if (!isStringArray(raw.non_claims)) {
    errors.push({ code: "CARRIER_NON_CLAIMS_INVALID", message: "non_claims must be an array of strings", path: "non_claims" });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, errors, carrier: raw as unknown as SupplyChainCarrier };
}

// ---------------------------------------------------------------------------
// Report construction
// ---------------------------------------------------------------------------

function flattenDimensions(carrier: SupplyChainCarrier): DimensionStatus[] {
  const out: DimensionStatus[] = [];
  for (const [group, dims] of Object.entries(carrier.checks)) {
    for (const [name, status] of Object.entries(dims)) {
      out.push({ group, name, status, class: classifyStatus(status) });
    }
  }
  return out.sort((a, b) => {
    const g = a.group.localeCompare(b.group);
    return g !== 0 ? g : a.name.localeCompare(b.name);
  });
}

export function buildSupplyChainReport(carrierPath: string): SupplyChainReport {
  const empty: SupplyChainReport["counts"] = { verified: 0, blocking: 0, pending: 0, not_applicable: 0 };
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
      passed: false,
      dimensions: [],
      counts: { ...empty },
    };
  }

  const validation = validateSupplyChainConformance(parsed);
  if (!validation.valid || !validation.carrier) {
    return { carrier_path: carrierPath, validation, passed: false, dimensions: [], counts: { ...empty } };
  }

  const carrier = validation.carrier;
  const dimensions = flattenDimensions(carrier);
  const counts = { ...empty };
  for (const d of dimensions) counts[d.class] += 1;

  return {
    carrier_path: carrierPath,
    validation,
    policy_result: carrier.policy_result,
    passed: carrier.policy_result === "pass",
    dimensions,
    counts,
  };
}

export interface SupplyChainLoadResult {
  ok: boolean;
  not_found?: boolean;
  report?: SupplyChainReport;
}

export function loadSupplyChainReport(carrierPath: string): SupplyChainLoadResult {
  if (!carrierPath || !existsSync(carrierPath)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, report: buildSupplyChainReport(carrierPath) };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function statusLine(report: SupplyChainReport): string {
  if (!report.validation.valid) return "SUPPLY-CHAIN CARRIER INVALID";
  if (report.policy_result === "pass") return "OK";
  if (report.policy_result === "fail") return "SUPPLY-CHAIN CONFORMANCE FAIL";
  return "SUPPLY-CHAIN CONFORMANCE INCOMPLETE";
}

export function formatSupplyChainSummary(report: SupplyChainReport): string {
  return [
    "[carrier-supply-chain] schema: assay.supply_chain_conformance.v0",
    `[carrier-supply-chain] status: ${statusLine(report)}`,
    `[carrier-supply-chain] policy_result: ${report.policy_result ?? "(invalid)"}`,
    `[carrier-supply-chain] dimensions: verified=${report.counts.verified} blocking=${report.counts.blocking} pending=${report.counts.pending} not_applicable=${report.counts.not_applicable}`,
    `[carrier-supply-chain] artifact: ${report.carrier_path}`,
  ].join("\n");
}

export function formatSupplyChainMarkdown(report: SupplyChainReport): string {
  const lines: string[] = [];
  lines.push("# Supply-Chain Conformance Carrier Gate");
  lines.push("");
  lines.push(`**Status:** ${statusLine(report)}`);
  lines.push(`**Schema:** \`${SUPPLY_CHAIN_CONFORMANCE_SCHEMA}\``);
  lines.push(`**Carrier:** \`${report.carrier_path}\``);
  lines.push("");
  lines.push("> This gate surfaces the producer-computed `policy_result` from the carrier and");
  lines.push("> the per-dimension statuses it reports. It does not approve, certify, judge");
  lines.push("> compliance, or assert provider trust, runtime truth, or supply-chain safety;");
  lines.push("> policy-aware review is a separate step.");
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

  const carrier = report.validation.carrier as SupplyChainCarrier;
  lines.push(
    `- Subject: \`${carrier.subject.name}\` @ \`${carrier.subject.version}\` (\`${carrier.subject.digest}\`)`,
  );
  lines.push(`- Producer policy_result: \`${carrier.policy_result}\``);
  lines.push(
    `- SLSA build level: declared \`${carrier.declared.required_slsa_build_level}\`, verified \`${carrier.verified.slsa_build_level}\``,
  );
  lines.push("");

  lines.push("| Group | Dimension | Status | Class |");
  lines.push("| --- | --- | --- | --- |");
  for (const d of report.dimensions) {
    lines.push(`| ${d.group} | ${d.name} | \`${d.status}\` | ${d.class} |`);
  }
  lines.push("");

  const blocking = report.dimensions.filter((d) => d.class === "blocking");
  if (blocking.length > 0) {
    lines.push("## Blocking dimensions (carrier reports a failed verification)");
    lines.push("");
    for (const d of blocking) lines.push(`- \`${d.group}.${d.name}\`: \`${d.status}\``);
    lines.push("");
  }
  const pending = report.dimensions.filter((d) => d.class === "pending");
  if (pending.length > 0) {
    lines.push("## Unresolved dimensions (absent, unverifiable, or not checked)");
    lines.push("");
    for (const d of pending) lines.push(`- \`${d.group}.${d.name}\`: \`${d.status}\``);
    lines.push("");
  }

  if (carrier.coverage.limits.length > 0) {
    lines.push("## Coverage limits (carried from the carrier)");
    lines.push("");
    for (const l of carrier.coverage.limits) lines.push(`- ${l}`);
    lines.push("");
  }
  if (carrier.non_claims.length > 0) {
    lines.push("## Non-claims (carried from the carrier)");
    lines.push("");
    for (const nc of carrier.non_claims) lines.push(`- ${nc}`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

export { formatSupplyChainJUnit, formatSupplyChainSarif } from "./carrier_supply_chain_projections.js";

// ---------------------------------------------------------------------------
// Projection writing (CLI convenience)
// ---------------------------------------------------------------------------

function writeArtifact(path: string, content: string, label: string): void {
  try {
    const dir = dirname(path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, "utf8");
  } catch (err) {
    throw new SupplyChainProjectionError(
      `failed to write ${label} projection to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface SupplyChainArtifacts {
  markdown: string;
  junit: string;
  sarif: string;
}

/** Write the three projections into `outDir`. Throws `SupplyChainProjectionError` on write failure. */
export function writeSupplyChainProjections(report: SupplyChainReport, outDir: string): SupplyChainArtifacts {
  const markdown = formatSupplyChainMarkdown(report);
  const junit = formatSupplyChainJUnit(report);
  const sarif = formatSupplyChainSarif(report);
  writeArtifact(`${outDir}/supply-chain-conformance.md`, markdown, "Markdown");
  writeArtifact(`${outDir}/supply-chain-conformance.junit.xml`, junit, "JUnit XML");
  writeArtifact(`${outDir}/supply-chain-conformance.sarif.json`, sarif, "SARIF");
  return { markdown, junit, sarif };
}
