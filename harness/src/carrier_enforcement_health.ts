/**
 * Conformance carrier gate — `assay.enforcement_health.v1` adapter (Landlock TCP-connect domain).
 *
 * Consumer-not-owner. The producer (`Rul1an/assay`, `crates/assay-cli/src/enforcement_health_v1.rs`)
 * reports whether Landlock TCP-connect port-allowlist enforcement was ACTIVE (the ruleset was applied:
 * `no_new_privs` set and `restrict_self` confirmed) or FAILED (requested but not installed), plus an
 * optional real-block probe. The Harness validates the frozen shape, gates CI on the producer-reported
 * status, and projects Markdown / JUnit / SARIF.
 *
 * Gate (carrier-local honest-state): status=active -> clean; status=failed -> not clean. A probe, when
 * present, upgrades the evidence from "ruleset applied" to "a denied connect was really blocked before
 * the listener was reached"; it is surfaced but not required for a clean gate.
 *
 * BOUNDARY: this is the carrier-local honest-state gate (was enforcement requested, and did the ruleset
 * apply or fail). It is NOT the enforcement-truth REVIEW (policy-aware approval over the enforcement
 * outcome), which remains the private Plimsoll consumer's job. v1 is the Landlock TCP-connect domain;
 * the connect4/eBPF `assay.enforcement_health.v0` carrier is a different shape and is not consumed here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";

export const ENFORCEMENT_HEALTH_V1_SCHEMA = "assay.enforcement_health.v1";

/** Frozen status set (producer `Status`, snake_case): no `not_applicable`, no `absent`. */
export const KNOWN_STATUSES: readonly string[] = ["active", "failed"];

export interface EnforcementProbe {
  kind: string;
  transport: string;
  blocked_action: string;
  blocked_port: number;
  blocked_errno: string;
  listener_reached: boolean;
}

export interface EnforcementHealthCarrier {
  schema: string;
  status: string;
  mechanism: string;
  scope: string;
  policy_semantics: string;
  failure?: { reason_code: string; detail: string };
  landlock: Record<string, unknown>;
  probe: EnforcementProbe | null;
  non_claims: string[];
}

export interface CarrierValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface EnforcementHealthValidation {
  valid: boolean;
  errors: CarrierValidationError[];
  carrier?: EnforcementHealthCarrier;
}

export interface EnforcementHealthReport {
  carrier_path: string;
  validation: EnforcementHealthValidation;
  /** `true` iff the carrier validated and status is `active`. CLI maps `!passed` to exit 6. */
  passed: boolean;
  status?: string;
  /** A real-block probe ran and a denied connect was blocked before the listener (EACCES, not reached). */
  real_block_proven: boolean;
}

export class EnforcementHealthProjectionError extends Error {
  readonly kind: "ci_formatter";
  constructor(message: string) {
    super(message);
    this.name = "EnforcementHealthProjectionError";
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

function validateProbe(value: unknown, errors: CarrierValidationError[]): void {
  if (value === null) return; // null is valid (no probe ran), per the null-over-absent rule
  if (!isRecord(value)) {
    errors.push({ code: "CARRIER_PROBE_INVALID", message: "probe must be null or an object", path: "probe" });
    return;
  }
  for (const k of ["kind", "transport", "blocked_action", "blocked_errno"] as const) {
    if (!isNonEmptyString(value[k])) {
      errors.push({ code: "CARRIER_PROBE_FIELD_INVALID", message: `probe.${k} must be a non-empty string`, path: `probe.${k}` });
    }
  }
  if (
    typeof value.blocked_port !== "number" ||
    !Number.isInteger(value.blocked_port) ||
    value.blocked_port < 0 ||
    value.blocked_port > 65535
  ) {
    errors.push({
      code: "CARRIER_PROBE_FIELD_INVALID",
      message: "probe.blocked_port must be an integer in 0..65535 (a TCP port)",
      path: "probe.blocked_port",
    });
  }
  if (typeof value.listener_reached !== "boolean") {
    errors.push({ code: "CARRIER_PROBE_FIELD_INVALID", message: "probe.listener_reached must be a boolean", path: "probe.listener_reached" });
  }
}

export function validateEnforcementHealthV1(raw: unknown): EnforcementHealthValidation {
  const errors: CarrierValidationError[] = [];

  if (!isRecord(raw)) {
    return {
      valid: false,
      errors: [{ code: "CARRIER_NOT_OBJECT", message: "enforcement-health carrier must be a JSON object" }],
    };
  }
  if (raw.schema !== ENFORCEMENT_HEALTH_V1_SCHEMA) {
    return {
      valid: false,
      errors: [
        {
          code: "CARRIER_SCHEMA_MISMATCH",
          message: `Expected schema ${ENFORCEMENT_HEALTH_V1_SCHEMA}; got ${
            raw.schema === undefined ? "(missing)" : JSON.stringify(raw.schema)
          }`,
          path: "schema",
        },
      ],
    };
  }

  if (typeof raw.status !== "string" || !KNOWN_STATUSES.includes(raw.status)) {
    errors.push({
      code: "CARRIER_STATUS_UNKNOWN",
      message: `status must be one of ${JSON.stringify(KNOWN_STATUSES)}; got ${JSON.stringify(raw.status)}`,
      path: "status",
    });
  }

  for (const k of ["mechanism", "scope", "policy_semantics"] as const) {
    if (!isNonEmptyString(raw[k])) {
      errors.push({ code: "CARRIER_FIELD_INVALID", message: `${k} must be a non-empty string`, path: k });
    }
  }

  if (!isRecord(raw.landlock)) {
    errors.push({ code: "CARRIER_LANDLOCK_INVALID", message: "landlock must be an object", path: "landlock" });
  } else {
    if (typeof raw.landlock.abi !== "number" || !Number.isInteger(raw.landlock.abi) || raw.landlock.abi < 0) {
      errors.push({ code: "CARRIER_LANDLOCK_FIELD_INVALID", message: "landlock.abi must be a non-negative integer", path: "landlock.abi" });
    }
    for (const k of ["no_new_privs_confirmed", "restrict_self_confirmed"] as const) {
      if (typeof raw.landlock[k] !== "boolean") {
        errors.push({ code: "CARRIER_LANDLOCK_FIELD_INVALID", message: `landlock.${k} must be a boolean`, path: `landlock.${k}` });
      }
    }
  }

  // probe key must be present (null when no probe ran), per the producer's null-over-absent rule.
  if (!("probe" in raw)) {
    errors.push({ code: "CARRIER_PROBE_MISSING", message: "probe must be present (null when no real-block probe ran)", path: "probe" });
  } else {
    validateProbe(raw.probe, errors);
  }

  // failure must be present + well-formed on the failed path.
  if (raw.status === "failed") {
    if (!isRecord(raw.failure) || !isNonEmptyString(raw.failure.reason_code) || typeof raw.failure.detail !== "string") {
      errors.push({
        code: "CARRIER_FAILURE_INVALID",
        message: "failed status requires failure { reason_code: string, detail: string }",
        path: "failure",
      });
    }
  } else if (raw.failure !== undefined && !isRecord(raw.failure)) {
    errors.push({ code: "CARRIER_FAILURE_INVALID", message: "failure must be an object when present", path: "failure" });
  }

  if (!isStringArray(raw.non_claims)) {
    errors.push({ code: "CARRIER_NON_CLAIMS_INVALID", message: "non_claims must be an array of strings", path: "non_claims" });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors, carrier: raw as unknown as EnforcementHealthCarrier };
}

export function buildEnforcementHealthReport(carrierPath: string): EnforcementHealthReport {
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
      real_block_proven: false,
    };
  }

  const validation = validateEnforcementHealthV1(parsed);
  if (!validation.valid || !validation.carrier) {
    return { carrier_path: carrierPath, validation, passed: false, real_block_proven: false };
  }

  const c = validation.carrier;
  const real_block_proven =
    c.probe !== null && c.probe.listener_reached === false && c.probe.blocked_errno.length > 0;
  return {
    carrier_path: carrierPath,
    validation,
    passed: c.status === "active",
    status: c.status,
    real_block_proven,
  };
}

export interface EnforcementHealthLoadResult {
  ok: boolean;
  not_found?: boolean;
  report?: EnforcementHealthReport;
}

export function loadEnforcementHealthReport(carrierPath: string): EnforcementHealthLoadResult {
  if (!carrierPath || !existsSync(carrierPath)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, report: buildEnforcementHealthReport(carrierPath) };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function statusLine(report: EnforcementHealthReport): string {
  if (!report.validation.valid) return "ENFORCEMENT-HEALTH CARRIER INVALID";
  return report.passed ? "OK" : "ENFORCEMENT NOT ACTIVE";
}

export function formatEnforcementHealthSummary(report: EnforcementHealthReport): string {
  return [
    "[carrier-enforcement-health] schema: assay.enforcement_health.v1",
    `[carrier-enforcement-health] status: ${statusLine(report)}`,
    `[carrier-enforcement-health] enforcement_status: ${report.status ?? "(invalid)"}`,
    `[carrier-enforcement-health] real_block_proven: ${report.real_block_proven}`,
    `[carrier-enforcement-health] artifact: ${report.carrier_path}`,
  ].join("\n");
}

export function formatEnforcementHealthMarkdown(report: EnforcementHealthReport): string {
  const lines: string[] = [];
  lines.push("# Enforcement-Health Conformance Carrier Gate");
  lines.push("");
  lines.push(`**Status:** ${statusLine(report)}`);
  lines.push(`**Schema:** \`${ENFORCEMENT_HEALTH_V1_SCHEMA}\``);
  lines.push(`**Carrier:** \`${report.carrier_path}\``);
  lines.push("");
  lines.push("> This gate surfaces the producer-reported enforcement status (was Landlock TCP-connect");
  lines.push("> enforcement active or failed) and whether a real-block probe confirmed a denied connect.");
  lines.push("> It is the carrier-local honest-state gate, not the enforcement-truth review (policy-aware");
  lines.push("> approval over the enforcement outcome), which is a separate step.");
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

  const c = report.validation.carrier as EnforcementHealthCarrier;
  lines.push(`- Mechanism: \`${c.mechanism}\` · scope: \`${c.scope}\` · policy: \`${c.policy_semantics}\``);
  lines.push(`- Enforcement status: \`${c.status}\``);
  lines.push(
    `- Real-block probe: ${report.real_block_proven ? "confirmed (a denied connect was blocked before the listener)" : c.probe === null ? "none (ruleset applied, no real-block claim)" : "present but not a confirmed block"}`,
  );
  if (c.status === "failed" && c.failure) {
    lines.push(`- Failure: \`${c.failure.reason_code}\` — ${c.failure.detail}`);
  }
  lines.push("");
  if (c.non_claims.length > 0) {
    lines.push("## Non-claims (carried from the carrier)");
    lines.push("");
    for (const nc of c.non_claims) lines.push(`- ${nc}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function xmlEscape(value: string): string {
  // Replace XML 1.0 forbidden control characters (they cannot appear even escaped)
  // with U+FFFD, then escape entities, so a control byte in producer-supplied text
  // cannot produce malformed JUnit that breaks CI parsers.
  let cleaned = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    cleaned += cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d ? "�" : ch;
  }
  return cleaned
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function formatEnforcementHealthJUnit(report: EnforcementHealthReport): string {
  const failed = !report.passed;
  const message = report.validation.valid
    ? `enforcement status is ${report.status}`
    : report.validation.errors.map((e) => e.code).join(",");
  const open = `    <testcase classname="assay.enforcement_health" name="enforcement_status" time="0">`;
  const body = failed
    ? [open, `      <failure message="${xmlEscape(message)}">${xmlEscape(message)}</failure>`, "    </testcase>", ""].join("\n")
    : `${open}</testcase>\n`;
  const summary = `status=${statusLine(report)} enforcement_status=${report.status ?? "invalid"} real_block_proven=${report.real_block_proven}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `  <testsuite name="assay.enforcement_health" tests="1" failures="${failed ? 1 : 0}" errors="0" skipped="0" time="0">`,
    body,
    `    <system-out>${xmlEscape(summary)}</system-out>`,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json";

const SARIF_RULES = [
  {
    id: "assay.carrier.enforcement_health.failed",
    name: "EnforcementHealthFailed",
    shortDescription: { text: "Enforcement was requested but not installed" },
    fullDescription: {
      text: "The enforcement-health carrier reports status=failed: enforcement was requested but the ruleset could not be installed (carries failure.reason_code).",
    },
    defaultConfiguration: { level: "error" },
    properties: { "security-severity": "7.0" },
  },
];

function relativeUri(carrierPath: string): string {
  const base = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const abs = resolve(carrierPath);
  if (abs.startsWith(base + "/")) return abs.slice(base.length + 1);
  return basename(carrierPath);
}

export function formatEnforcementHealthSarif(report: EnforcementHealthReport): string {
  const uri = relativeUri(report.carrier_path);
  const results: unknown[] = [];
  if (report.validation.valid && !report.passed) {
    const c = report.validation.carrier as EnforcementHealthCarrier;
    const reason = c.failure?.reason_code ?? "unknown";
    results.push({
      ruleId: "assay.carrier.enforcement_health.failed",
      level: "error",
      message: { text: `enforcement failed: ${reason}` },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }],
      partialFingerprints: { enforcement: `failed:${reason}` },
      properties: { status: c.status, reason_code: reason, scope: c.scope },
    });
  }
  return (
    JSON.stringify(
      {
        $schema: SARIF_SCHEMA,
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "assay-harness-enforcement-health-carrier",
                version: "0.8.0",
                informationUri: "https://github.com/Rul1an/Assay-Harness",
                rules: SARIF_RULES,
              },
            },
            results,
            automationDetails: { id: "assay-harness/enforcement-health/" },
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

function writeArtifact(path: string, content: string, label: string): void {
  try {
    const dir = dirname(path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, "utf8");
  } catch (err) {
    throw new EnforcementHealthProjectionError(
      `failed to write ${label} projection to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function writeEnforcementHealthProjections(report: EnforcementHealthReport, outDir: string): void {
  writeArtifact(`${outDir}/enforcement-health.md`, formatEnforcementHealthMarkdown(report), "Markdown");
  writeArtifact(`${outDir}/enforcement-health.junit.xml`, formatEnforcementHealthJUnit(report), "JUnit XML");
  writeArtifact(`${outDir}/enforcement-health.sarif.json`, formatEnforcementHealthSarif(report), "SARIF");
}
