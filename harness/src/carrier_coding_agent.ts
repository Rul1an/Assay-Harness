/**
 * Descriptive carrier projector — `assay.coding_agent.evidence_pack.v0` (coding-agent run evidence).
 *
 * Consumer-not-owner. The producer (`Rul1an/assay`, `crates/assay-evidence/src/coding_agent.rs`,
 * `coding_agent_evidence_event`) emits an EvidenceEvent recording one coding-agent run: declared scope,
 * observed effects, per-surface coverage, source class, and non-claims, with a hard `content_hash` on the
 * event. The Harness validates the frozen shape and projects a reviewer-facing review that surfaces the
 * signals a 2026 agent-PR reviewer needs — declared-vs-observed scope deltas, coverage gaps on the core
 * surfaces, the source-class basis, and the integrity anchor — WITHOUT deciding anything.
 *
 * INPUT IS AN EVENT, NOT A STANDALONE CARRIER. Unlike the schema-keyed carriers (inventory, supply-chain)
 * the coding-agent evidence is an EvidenceEvent payload identified by `type` (== this schema id), not a
 * top-level `schema` field, so it is handled by its own verb and not registered in the schema-keyed
 * carrier_registry (whose dispatch reads `raw.schema`).
 *
 * DESCRIPTIVE / NON-GATING: a valid event exits 0 regardless of contents; only a malformed / wrong-type /
 * missing-required-field event is a contract error (exit 3). The bounded verdict
 * (pass/mismatch/incomplete/invalid) and effect-sufficiency are a separate downstream review consumer's job, never
 * the Harness's. The `content_hash` is surfaced as the producer's integrity anchor; the Harness does NOT
 * re-verify it here — pack-level integrity binding is the separate (and currently gated) evidence-pack layer.
 *
 * GATE: a full `suite.evidence_pack.v0` carrying this carrier is intentionally NOT built yet. That needs a
 * RELEASED Assay with the primitive, a hermetic recipe that emits it, and a proven suite-matrix row, so the
 * pack's coherence invariant holds without fabricated provenance.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The frozen event `type` of the coding-agent evidence primitive (producer-owned). */
export const CODING_AGENT_EVIDENCE_EVENT_TYPE = "assay.coding_agent.evidence_pack.v0";

/** Frozen per-surface coverage states (producer `CodingAgentCoverageState`). Only `observed` is a watched surface. */
export const KNOWN_COVERAGE_STATES: readonly string[] = [
  "observed",
  "unavailable",
  "self_reported",
  "absent",
  "partial",
];

/** Frozen declared network policy (producer `CodingAgentNetworkPolicy`); always required, never omitted. */
export const KNOWN_NETWORK_POLICIES: readonly string[] = ["allowed", "denied"];

/** Frozen source classes (producer `CodingAgentSourceClass`). */
export const KNOWN_SOURCE_CLASSES: readonly string[] = [
  "boundary_observed",
  "independently_observed",
  "third_party_observed",
  "producer_reported",
  "issuer_attested",
  "receiver_receipt",
];

/**
 * Source classes whose observation is independent enough to support a clean downstream review. This is a
 * DESCRIPTIVE input the reviewer sees, not a decision: the source-class ceiling is the consumer's to apply.
 */
export const OBSERVED_SOURCE_CLASSES: readonly string[] = [
  "boundary_observed",
  "independently_observed",
  "third_party_observed",
];

/** The core coding-agent surfaces whose coverage a reviewer should always be able to read. */
const CORE_SURFACES = ["files", "commands", "network", "mcp_tools"] as const;

export interface CodingAgentDeclaredScope {
  allowed_files: string[];
  allowed_commands: string[];
  network: string;
  allowed_mcp_tools: string[];
  expected_test_command?: string;
  authorized: boolean;
}

export interface CodingAgentObservedEffects {
  files_changed: string[];
  commands_executed: string[];
  network_attempts: string[];
  mcp_tool_calls: string[];
  test_observed: boolean;
}

export interface CodingAgentCoverage {
  files: string;
  commands: string;
  network: string;
  mcp_tools: string;
  test: string;
}

export interface CodingAgentPayload {
  declared_scope: CodingAgentDeclaredScope;
  observed_effects: CodingAgentObservedEffects;
  coverage: CodingAgentCoverage;
  source_class: string;
  non_claims: string[];
}

export interface CodingAgentEvent {
  type: string;
  content_hash: string;
  data: CodingAgentPayload;
}

export interface CarrierValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface CodingAgentValidation {
  valid: boolean;
  errors: CarrierValidationError[];
  event?: CodingAgentEvent;
}

/** Descriptive review signals derived from the event. None of these is a verdict. */
export interface CodingAgentSignals {
  out_of_scope_files: string[];
  out_of_scope_commands: string[];
  out_of_scope_mcp_tools: string[];
  network_attempts_despite_denied: boolean;
  /** Core surfaces (+ test, when a test command was declared) whose coverage is not `observed`. */
  coverage_gaps: string[];
  /** True iff the source class is an independent-observation class (descriptive input to the ceiling). */
  source_class_is_observed: boolean;
  /** True iff a hard `content_hash` is present in `sha256:` form (producer anchor; not re-verified here). */
  integrity_anchor_present: boolean;
}

export interface CodingAgentReport {
  carrier_path: string;
  validation: CodingAgentValidation;
  content_hash?: string;
  signals?: CodingAgentSignals;
}

export class CodingAgentProjectionError extends Error {
  readonly kind: "ci_formatter";
  constructor(message: string) {
    super(message);
    this.name = "CodingAgentProjectionError";
    this.kind = "ci_formatter";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isKnownCoverage(value: unknown): value is string {
  return typeof value === "string" && KNOWN_COVERAGE_STATES.includes(value);
}

function validateDeclaredScope(raw: unknown, errors: CarrierValidationError[]): void {
  const base = "data.declared_scope";
  if (!isRecord(raw)) {
    errors.push({ code: "CARRIER_SCOPE_INVALID", message: `${base} must be an object`, path: base });
    return;
  }
  for (const k of ["allowed_files", "allowed_commands", "allowed_mcp_tools"] as const) {
    if (!isStringArray(raw[k])) {
      errors.push({
        code: "CARRIER_SCOPE_INVALID",
        message: `${base}.${k} must be an array of strings`,
        path: `${base}.${k}`,
      });
    }
  }
  // network is a high-blast-radius surface: an explicit policy is required, never omitted.
  if (typeof raw.network !== "string" || !KNOWN_NETWORK_POLICIES.includes(raw.network)) {
    errors.push({
      code: "CARRIER_NETWORK_POLICY_INVALID",
      message: `${base}.network is required and must be one of ${JSON.stringify(KNOWN_NETWORK_POLICIES)}; got ${
        raw.network === undefined ? "(missing)" : JSON.stringify(raw.network)
      }`,
      path: `${base}.network`,
    });
  }
  if (typeof raw.authorized !== "boolean") {
    errors.push({ code: "CARRIER_SCOPE_INVALID", message: `${base}.authorized must be a boolean`, path: `${base}.authorized` });
  }
  if (
    raw.expected_test_command !== undefined &&
    (typeof raw.expected_test_command !== "string" || raw.expected_test_command.length === 0)
  ) {
    errors.push({
      code: "CARRIER_SCOPE_INVALID",
      message: `${base}.expected_test_command must be a non-empty string when present`,
      path: `${base}.expected_test_command`,
    });
  }
}

function validateObservedEffects(raw: unknown, errors: CarrierValidationError[]): void {
  const base = "data.observed_effects";
  if (!isRecord(raw)) {
    errors.push({ code: "CARRIER_OBSERVED_INVALID", message: `${base} must be an object`, path: base });
    return;
  }
  for (const k of ["files_changed", "commands_executed", "network_attempts", "mcp_tool_calls"] as const) {
    if (!isStringArray(raw[k])) {
      errors.push({
        code: "CARRIER_OBSERVED_INVALID",
        message: `${base}.${k} must be an array of strings`,
        path: `${base}.${k}`,
      });
    }
  }
  if (typeof raw.test_observed !== "boolean") {
    errors.push({ code: "CARRIER_OBSERVED_INVALID", message: `${base}.test_observed must be a boolean`, path: `${base}.test_observed` });
  }
}

function validateCoverage(raw: unknown, errors: CarrierValidationError[]): void {
  const base = "data.coverage";
  if (!isRecord(raw)) {
    errors.push({ code: "CARRIER_COVERAGE_INVALID", message: `${base} must be an object`, path: base });
    return;
  }
  // Every core surface plus `test` must be present and a known state; a missing surface (e.g. network) is a
  // contract error, never silently treated as covered.
  for (const surface of [...CORE_SURFACES, "test"] as const) {
    if (!(surface in raw)) {
      errors.push({
        code: "CARRIER_COVERAGE_SURFACE_MISSING",
        message: `${base}.${surface} is required (an unobserved surface must be stated explicitly, not omitted)`,
        path: `${base}.${surface}`,
      });
    } else if (!isKnownCoverage(raw[surface])) {
      errors.push({
        code: "CARRIER_COVERAGE_STATE_UNKNOWN",
        message: `${base}.${surface} must be a known coverage state (${JSON.stringify(KNOWN_COVERAGE_STATES)}); got ${JSON.stringify(raw[surface])}`,
        path: `${base}.${surface}`,
      });
    }
  }
}

export function validateCodingAgentEvent(raw: unknown): CodingAgentValidation {
  if (!isRecord(raw)) {
    return {
      valid: false,
      errors: [{ code: "CARRIER_NOT_OBJECT", message: "coding-agent evidence event must be a JSON object" }],
    };
  }
  if (raw.type !== CODING_AGENT_EVIDENCE_EVENT_TYPE) {
    return {
      valid: false,
      errors: [
        {
          code: "CARRIER_TYPE_MISMATCH",
          message: `Expected event type ${CODING_AGENT_EVIDENCE_EVENT_TYPE}; got ${
            raw.type === undefined ? "(missing)" : JSON.stringify(raw.type)
          }`,
          path: "type",
        },
      ],
    };
  }

  const errors: CarrierValidationError[] = [];
  // The producer serializes the hard content hash as the CloudEvents extension `assaycontenthash`
  // (Rust `EvidenceEvent.content_hash`, serde rename). Read the wire name, not the Rust field name.
  if (!isSha256(raw.assaycontenthash)) {
    errors.push({
      code: "CARRIER_CONTENT_HASH_INVALID",
      message: "assaycontenthash must be a hard producer anchor in 'sha256:<64 hex>' form",
      path: "assaycontenthash",
    });
  }
  if (!isRecord(raw.data)) {
    errors.push({ code: "CARRIER_DATA_INVALID", message: "data (the payload) must be an object", path: "data" });
    return { valid: false, errors };
  }
  const data = raw.data;
  validateDeclaredScope(data.declared_scope, errors);
  validateObservedEffects(data.observed_effects, errors);
  validateCoverage(data.coverage, errors);
  if (typeof data.source_class !== "string" || !KNOWN_SOURCE_CLASSES.includes(data.source_class)) {
    errors.push({
      code: "CARRIER_SOURCE_CLASS_UNKNOWN",
      message: `data.source_class must be one of ${JSON.stringify(KNOWN_SOURCE_CLASSES)}; got ${JSON.stringify(data.source_class)}`,
      path: "data.source_class",
    });
  }
  if (!isStringArray(data.non_claims)) {
    errors.push({ code: "CARRIER_NON_CLAIMS_INVALID", message: "data.non_claims must be an array of strings", path: "data.non_claims" });
  }

  if (errors.length > 0) return { valid: false, errors };
  // Normalize to a clean internal shape: the wire envelope (`assaycontenthash`, `data`, ...) becomes the
  // internal `content_hash` / `data` the rest of this module reads.
  return {
    valid: true,
    errors,
    event: {
      type: CODING_AGENT_EVIDENCE_EVENT_TYPE,
      content_hash: raw.assaycontenthash as string,
      data: raw.data as unknown as CodingAgentPayload,
    },
  };
}

/** Compute the descriptive review signals. Never a verdict — just what a reviewer should see. */
export function deriveSignals(event: CodingAgentEvent): CodingAgentSignals {
  const d = event.data.declared_scope;
  const o = event.data.observed_effects;
  const cov = event.data.coverage;
  const notIn = (items: string[], allowed: string[]) => items.filter((x) => !allowed.includes(x));

  const relevantSurfaces: (keyof CodingAgentCoverage)[] = [...CORE_SURFACES];
  // `test` is a relevant surface only when a (non-empty) test command was declared; this keeps the
  // coverage-gap signal consistent with how the projection renders the declared test command.
  if (d.expected_test_command) relevantSurfaces.push("test");

  return {
    out_of_scope_files: notIn(o.files_changed, d.allowed_files),
    out_of_scope_commands: notIn(o.commands_executed, d.allowed_commands),
    out_of_scope_mcp_tools: notIn(o.mcp_tool_calls, d.allowed_mcp_tools),
    network_attempts_despite_denied: d.network === "denied" && o.network_attempts.length > 0,
    coverage_gaps: relevantSurfaces.filter((s) => cov[s] !== "observed"),
    source_class_is_observed: OBSERVED_SOURCE_CLASSES.includes(event.data.source_class),
    integrity_anchor_present: isSha256(event.content_hash),
  };
}

export function buildCodingAgentReport(carrierPath: string): CodingAgentReport {
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
    };
  }

  const validation = validateCodingAgentEvent(parsed);
  if (!validation.valid || !validation.event) {
    return { carrier_path: carrierPath, validation };
  }
  const event = validation.event;
  return {
    carrier_path: carrierPath,
    validation,
    content_hash: event.content_hash,
    signals: deriveSignals(event),
  };
}

export interface CodingAgentLoadResult {
  ok: boolean;
  not_found?: boolean;
  report?: CodingAgentReport;
}

export function loadCodingAgentReport(carrierPath: string): CodingAgentLoadResult {
  if (!carrierPath || !existsSync(carrierPath)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, report: buildCodingAgentReport(carrierPath) };
}

export function formatCodingAgentSummary(report: CodingAgentReport): string {
  const status = report.validation.valid ? "DESCRIBED" : "CODING-AGENT EVIDENCE INVALID";
  const s = report.signals;
  return [
    `[carrier-coding-agent] schema: ${CODING_AGENT_EVIDENCE_EVENT_TYPE}`,
    `[carrier-coding-agent] status: ${status}`,
    s ? `[carrier-coding-agent] out_of_scope: files=${s.out_of_scope_files.length} commands=${s.out_of_scope_commands.length} mcp=${s.out_of_scope_mcp_tools.length}` : "",
    s ? `[carrier-coding-agent] coverage_gaps: ${s.coverage_gaps.length === 0 ? "none" : s.coverage_gaps.join(",")}` : "",
    s ? `[carrier-coding-agent] source_class_observed: ${s.source_class_is_observed}` : "",
    `[carrier-coding-agent] artifact: ${report.carrier_path}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function mdCell(value: string): string {
  // A pipe or newline in a producer-supplied value would break the Markdown table.
  return value.replace(/\r\n|\r|\n/g, " ").replaceAll("|", "\\|");
}

function mdList(items: string[]): string {
  return items.length === 0 ? "none" : items.map(mdCell).join(", ");
}

export function formatCodingAgentMarkdown(report: CodingAgentReport): string {
  const lines: string[] = [];
  lines.push("# Coding-Agent Run Evidence (descriptive)");
  lines.push("");
  lines.push(`**Event type:** \`${CODING_AGENT_EVIDENCE_EVENT_TYPE}\``);
  lines.push(`**Carrier:** \`${report.carrier_path}\``);
  lines.push("");
  lines.push("> Descriptive reviewer context, not a gate and not a verdict. The Harness surfaces what the");
  lines.push("> run declared and what was observed; it does not decide whether the run is acceptable,");
  lines.push("> sufficient, or in or out of policy. The bounded judgment over these facts is a separate");
  lines.push("> downstream review (a bounded review consumer's job).");
  lines.push("");

  if (!report.validation.valid) {
    lines.push("## Carrier validation errors");
    lines.push("");
    for (const e of report.validation.errors) {
      lines.push(`- \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
    }
    lines.push("");
    return lines.join("\n") + "\n";
  }

  const event = report.validation.event as CodingAgentEvent;
  const d = event.data.declared_scope;
  const o = event.data.observed_effects;
  const cov = event.data.coverage;
  const s = report.signals as CodingAgentSignals;

  lines.push("## Declared scope");
  lines.push("");
  lines.push("| Surface | Declared |");
  lines.push("| --- | --- |");
  lines.push(`| Files | ${mdList(d.allowed_files)} |`);
  lines.push(`| Commands | ${mdList(d.allowed_commands)} |`);
  lines.push(`| Network | \`${mdCell(d.network)}\` |`);
  lines.push(`| MCP tools | ${mdList(d.allowed_mcp_tools)} |`);
  lines.push(`| Test command | ${d.expected_test_command ? `\`${mdCell(d.expected_test_command)}\`` : "none declared"} |`);
  lines.push(`| Authorized | ${d.authorized} |`);
  lines.push("");

  lines.push("## Observed effects");
  lines.push("");
  lines.push("| Surface | Observed |");
  lines.push("| --- | --- |");
  lines.push(`| Files changed | ${mdList(o.files_changed)} |`);
  lines.push(`| Commands executed | ${mdList(o.commands_executed)} |`);
  lines.push(`| Network attempts | ${mdList(o.network_attempts)} |`);
  lines.push(`| MCP tool calls | ${mdList(o.mcp_tool_calls)} |`);
  lines.push(`| Test observed | ${o.test_observed} |`);
  lines.push("");

  lines.push("## Coverage (per surface)");
  lines.push("");
  lines.push("| Surface | Coverage |");
  lines.push("| --- | --- |");
  for (const surface of [...CORE_SURFACES, "test"] as const) {
    lines.push(`| ${surface} | \`${cov[surface]}\` |`);
  }
  lines.push("");
  lines.push("An unobserved surface is a visible gap, not a clean result: absence of observation is not");
  lines.push("absence of effect.");
  lines.push("");

  lines.push("## Review signals (for a human or downstream review consumer, not a verdict)");
  lines.push("");
  lines.push(`- Files changed outside declared scope: ${mdList(s.out_of_scope_files)}`);
  lines.push(`- Commands executed outside declared scope: ${mdList(s.out_of_scope_commands)}`);
  lines.push(`- MCP tool calls outside declared scope: ${mdList(s.out_of_scope_mcp_tools)}`);
  let networkNote: string;
  if (d.network === "denied") {
    networkNote = s.network_attempts_despite_denied
      ? `${o.network_attempts.length} network attempt(s) observed despite the denied policy`
      : "no network attempts observed against the denied policy";
  } else {
    networkNote =
      o.network_attempts.length > 0
        ? `${o.network_attempts.length} network attempt(s) observed (network allowed)`
        : "no network attempts observed (network allowed)";
  }
  lines.push(`- Network: declared \`${mdCell(d.network)}\`; ${networkNote}`);
  lines.push(`- Coverage gaps (relevant surfaces not observed): ${mdList(s.coverage_gaps)}`);
  lines.push(
    `- Source-class basis: \`${mdCell(event.data.source_class)}\` (${
      s.source_class_is_observed
        ? "an independent observation class"
        : "self-attested; does not, on its own, support a clean review"
    })`,
  );
  lines.push(
    `- Integrity anchor: ${
      s.integrity_anchor_present ? `\`${mdCell(report.content_hash ?? "")}\`` : "missing"
    } (producer's hard content hash; surfaced here, not re-verified; pack-level binding is a separate layer)`,
  );
  lines.push("");

  if (event.data.non_claims.length > 0) {
    lines.push("## Non-claims (carried from the evidence)");
    lines.push("");
    for (const nc of event.data.non_claims) lines.push(`- ${mdCell(nc)}`);
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
    throw new CodingAgentProjectionError(
      `failed to write ${label} projection to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Descriptive projection: Markdown reviewer context only (no gating JUnit/SARIF). */
export function writeCodingAgentProjections(report: CodingAgentReport, outDir: string): void {
  writeArtifact(`${outDir}/coding-agent-review.md`, formatCodingAgentMarkdown(report), "Markdown");
}
