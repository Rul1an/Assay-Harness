/**
 * Conformance carrier gate — `assay.render_safety_conformance.v0` adapter.
 *
 * Consumer-not-owner. The producer (`Rul1an/assay`, `crates/assay-core/src/render_safety`)
 * runs a shared hostile/benign corpus through each render sink and records, per
 * sink: raw secret / PII / terminal-control leak counts, redaction-before-truncation,
 * benign-preserved, and the sink-specific encoding. The Harness validates the frozen
 * v0 shape, gates CI on those producer-reported facts, and projects Markdown / JUnit /
 * SARIF.
 *
 * Gate (mirrors the producer's own `is_clean`): a sink is clean iff it leaked no raw
 * secret, no raw PII, and no terminal control, AND preserved benign output, AND honoured
 * redaction-before-truncation. The report is clean iff every sink is clean and the sink
 * list is non-empty. Any sink failing any of those is not clean.
 *
 * Scope: this is per-sink render output safety only. It is NOT "all secrets protected",
 * not secret lifecycle / vaulting / rotation, and not a judgement of upstream redaction
 * configuration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";

export const RENDER_SAFETY_CONFORMANCE_SCHEMA = "assay.render_safety_conformance.v0";

export interface SinkConformance {
  sink: string;
  renderer: string;
  hostile_probe_count: number;
  benign_control_count: number;
  raw_secret_leak_count: number;
  raw_pii_leak_count: number;
  terminal_control_leak_count: number;
  redaction_before_truncation: boolean;
  benign_preserved: boolean;
  sink_specific_encoding: string;
}

export interface RenderSafetyCarrier {
  schema: string;
  corpus_digest: string;
  sinks: SinkConformance[];
}

export interface CarrierValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface RenderSafetyValidation {
  valid: boolean;
  errors: CarrierValidationError[];
  carrier?: RenderSafetyCarrier;
}

export interface SinkResult {
  sink: SinkConformance;
  issues: string[];
}

export interface RenderSafetyReport {
  carrier_path: string;
  validation: RenderSafetyValidation;
  /** `true` iff the carrier validated and every sink is clean. CLI maps `!passed` to exit 6. */
  passed: boolean;
  sinks: SinkResult[];
}

export class RenderSafetyProjectionError extends Error {
  readonly kind: "ci_formatter";
  constructor(message: string) {
    super(message);
    this.name = "RenderSafetyProjectionError";
    this.kind = "ci_formatter";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function validateRenderSafetyConformance(raw: unknown): RenderSafetyValidation {
  const errors: CarrierValidationError[] = [];

  if (!isRecord(raw)) {
    return {
      valid: false,
      errors: [{ code: "CARRIER_NOT_OBJECT", message: "render-safety carrier must be a JSON object" }],
    };
  }
  if (raw.schema !== RENDER_SAFETY_CONFORMANCE_SCHEMA) {
    return {
      valid: false,
      errors: [
        {
          code: "CARRIER_SCHEMA_MISMATCH",
          message: `Expected schema ${RENDER_SAFETY_CONFORMANCE_SCHEMA}; got ${
            raw.schema === undefined ? "(missing)" : JSON.stringify(raw.schema)
          }`,
          path: "schema",
        },
      ],
    };
  }

  if (!isNonEmptyString(raw.corpus_digest)) {
    errors.push({
      code: "CARRIER_CORPUS_DIGEST_INVALID",
      message: "corpus_digest must be a non-empty string",
      path: "corpus_digest",
    });
  }

  if (!Array.isArray(raw.sinks) || raw.sinks.length === 0) {
    errors.push({
      code: "CARRIER_SINKS_INVALID",
      message: "sinks must be a non-empty array",
      path: "sinks",
    });
  } else {
    raw.sinks.forEach((s: unknown, i: number) => {
      const path = `sinks[${i}]`;
      if (!isRecord(s)) {
        errors.push({ code: "CARRIER_SINK_SHAPE_INVALID", message: `${path} must be an object`, path });
        return;
      }
      for (const k of ["sink", "renderer", "sink_specific_encoding"] as const) {
        if (!isNonEmptyString(s[k])) {
          errors.push({
            code: "CARRIER_SINK_FIELD_INVALID",
            message: `${path}.${k} must be a non-empty string`,
            path: `${path}.${k}`,
          });
        }
      }
      for (const k of [
        "hostile_probe_count",
        "benign_control_count",
        "raw_secret_leak_count",
        "raw_pii_leak_count",
        "terminal_control_leak_count",
      ] as const) {
        if (!isNonNegativeInteger(s[k])) {
          errors.push({
            code: "CARRIER_SINK_COUNT_INVALID",
            message: `${path}.${k} must be a non-negative integer`,
            path: `${path}.${k}`,
          });
        }
      }
      for (const k of ["redaction_before_truncation", "benign_preserved"] as const) {
        if (typeof s[k] !== "boolean") {
          errors.push({
            code: "CARRIER_SINK_FLAG_INVALID",
            message: `${path}.${k} must be a boolean`,
            path: `${path}.${k}`,
          });
        }
      }
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors, carrier: raw as unknown as RenderSafetyCarrier };
}

/** The producer-reported reasons a sink is not clean (empty when clean). */
export function sinkIssues(s: SinkConformance): string[] {
  const issues: string[] = [];
  if (s.raw_secret_leak_count > 0) issues.push(`raw_secret_leak_count=${s.raw_secret_leak_count}`);
  if (s.raw_pii_leak_count > 0) issues.push(`raw_pii_leak_count=${s.raw_pii_leak_count}`);
  if (s.terminal_control_leak_count > 0) issues.push(`terminal_control_leak_count=${s.terminal_control_leak_count}`);
  if (!s.redaction_before_truncation) issues.push("redaction_before_truncation=false");
  if (!s.benign_preserved) issues.push("benign_preserved=false");
  return issues;
}

export function buildRenderSafetyReport(carrierPath: string): RenderSafetyReport {
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
      sinks: [],
    };
  }

  const validation = validateRenderSafetyConformance(parsed);
  if (!validation.valid || !validation.carrier) {
    return { carrier_path: carrierPath, validation, passed: false, sinks: [] };
  }

  const sinks = validation.carrier.sinks.map((s) => ({ sink: s, issues: sinkIssues(s) }));
  const passed = sinks.every((s) => s.issues.length === 0);
  return { carrier_path: carrierPath, validation, passed, sinks };
}

export interface RenderSafetyLoadResult {
  ok: boolean;
  not_found?: boolean;
  report?: RenderSafetyReport;
}

export function loadRenderSafetyReport(carrierPath: string): RenderSafetyLoadResult {
  if (!carrierPath || !existsSync(carrierPath)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, report: buildRenderSafetyReport(carrierPath) };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function statusLine(report: RenderSafetyReport): string {
  if (!report.validation.valid) return "RENDER-SAFETY CARRIER INVALID";
  return report.passed ? "OK" : "RENDER-SAFETY CONFORMANCE NOT CLEAN";
}

export function formatRenderSafetySummary(report: RenderSafetyReport): string {
  const unclean = report.sinks.filter((s) => s.issues.length > 0).length;
  return [
    "[carrier-render-safety] schema: assay.render_safety_conformance.v0",
    `[carrier-render-safety] status: ${statusLine(report)}`,
    `[carrier-render-safety] sinks: ${report.sinks.length} (unclean=${unclean})`,
    `[carrier-render-safety] artifact: ${report.carrier_path}`,
  ].join("\n");
}

export function formatRenderSafetyMarkdown(report: RenderSafetyReport): string {
  const lines: string[] = [];
  lines.push("# Render-Safety Conformance Carrier Gate");
  lines.push("");
  lines.push(`**Status:** ${statusLine(report)}`);
  lines.push(`**Schema:** \`${RENDER_SAFETY_CONFORMANCE_SCHEMA}\``);
  lines.push(`**Carrier:** \`${report.carrier_path}\``);
  lines.push("");
  lines.push("> This gate surfaces the producer-reported per-sink render-safety facts (raw");
  lines.push("> secret / PII / terminal-control leak counts, redaction-before-truncation,");
  lines.push("> benign-preserved). It covers render output safety per sink only; it is not a");
  lines.push("> claim about secret lifecycle, vaulting, rotation, or upstream redaction config.");
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

  const carrier = report.validation.carrier as RenderSafetyCarrier;
  lines.push(`- Corpus digest: \`${carrier.corpus_digest}\``);
  lines.push("");
  lines.push("| Sink | Encoding | Secret | PII | Control | Redact-before-truncate | Benign preserved |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- | --- |");
  for (const { sink: s } of report.sinks) {
    lines.push(
      `| ${s.sink} | ${s.sink_specific_encoding} | ${s.raw_secret_leak_count} | ${s.raw_pii_leak_count} | ${s.terminal_control_leak_count} | ${s.redaction_before_truncation} | ${s.benign_preserved} |`,
    );
  }
  lines.push("");

  const unclean = report.sinks.filter((s) => s.issues.length > 0);
  if (unclean.length > 0) {
    lines.push("## Sinks the carrier reports as not clean");
    lines.push("");
    for (const u of unclean) lines.push(`- \`${u.sink.sink}\`: ${u.issues.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function formatRenderSafetyJUnit(report: RenderSafetyReport): string {
  const cases = report.sinks.map((s) => ({
    name: s.sink.sink,
    failure: s.issues.length > 0,
    message: s.issues.length > 0 ? `${s.sink.sink}: ${s.issues.join(", ")}` : "",
  }));
  const failures = cases.filter((c) => c.failure).length;
  const body = cases
    .map((c) => {
      const open = `    <testcase classname="assay.render_safety_conformance" name="${xmlEscape(c.name)}" time="0">`;
      if (!c.failure) return `${open}</testcase>\n`;
      return [
        open,
        `      <failure message="${xmlEscape(c.message)}">${xmlEscape(c.message)}</failure>`,
        "    </testcase>",
        "",
      ].join("\n");
    })
    .join("");
  const summary = `status=${statusLine(report)} sinks=${report.sinks.length} unclean=${failures}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `  <testsuite name="assay.render_safety_conformance" tests="${cases.length}" failures="${failures}" errors="0" skipped="0" time="0">`,
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
    id: "assay.carrier.render_safety.raw_leak",
    name: "RenderSafetyRawLeak",
    shortDescription: { text: "Render sink reports a raw secret / PII / terminal-control leak" },
    fullDescription: {
      text: "A render sink reports a non-zero raw_secret_leak_count, raw_pii_leak_count, or terminal_control_leak_count.",
    },
    defaultConfiguration: { level: "error" },
    properties: { "security-severity": "7.0" },
  },
  {
    id: "assay.carrier.render_safety.truncation_order",
    name: "RenderSafetyTruncationOrder",
    shortDescription: { text: "Render sink did not redact before truncation" },
    fullDescription: {
      text: "redaction_before_truncation is false: truncating before redacting can leak a secret straddling the truncation boundary.",
    },
    defaultConfiguration: { level: "error" },
    properties: { "security-severity": "7.0" },
  },
  {
    id: "assay.carrier.render_safety.benign_overredacted",
    name: "RenderSafetyBenignOverredacted",
    shortDescription: { text: "Render sink did not preserve benign output" },
    fullDescription: {
      text: "benign_preserved is false: benign near-match content was over-redacted or encoded away.",
    },
    defaultConfiguration: { level: "warning" },
    properties: { "security-severity": "3.0" },
  },
];

function relativeUri(carrierPath: string): string {
  const base = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const abs = resolve(carrierPath);
  if (abs.startsWith(base + "/")) return abs.slice(base.length + 1);
  return basename(carrierPath);
}

export function formatRenderSafetySarif(report: RenderSafetyReport): string {
  const uri = relativeUri(report.carrier_path);
  const results: unknown[] = [];

  for (const { sink: s } of report.sinks) {
    const push = (ruleId: string, level: string, text: string) =>
      results.push({
        ruleId,
        level,
        message: { text: `${s.sink}: ${text}` },
        locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }],
        partialFingerprints: { sink: s.sink, rule: ruleId },
        properties: { sink: s.sink, encoding: s.sink_specific_encoding },
      });

    if (s.raw_secret_leak_count > 0) push("assay.carrier.render_safety.raw_leak", "error", `raw_secret_leak_count=${s.raw_secret_leak_count}`);
    if (s.raw_pii_leak_count > 0) push("assay.carrier.render_safety.raw_leak", "error", `raw_pii_leak_count=${s.raw_pii_leak_count}`);
    if (s.terminal_control_leak_count > 0) push("assay.carrier.render_safety.raw_leak", "error", `terminal_control_leak_count=${s.terminal_control_leak_count}`);
    if (!s.redaction_before_truncation) push("assay.carrier.render_safety.truncation_order", "error", "redaction_before_truncation=false");
    if (!s.benign_preserved) push("assay.carrier.render_safety.benign_overredacted", "warning", "benign_preserved=false");
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
                name: "assay-harness-render-safety-carrier",
                version: "0.8.0",
                informationUri: "https://github.com/Rul1an/Assay-Harness",
                rules: SARIF_RULES,
              },
            },
            results,
            automationDetails: { id: "assay-harness/render-safety-conformance/" },
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
    throw new RenderSafetyProjectionError(
      `failed to write ${label} projection to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function writeRenderSafetyProjections(report: RenderSafetyReport, outDir: string): void {
  writeArtifact(`${outDir}/render-safety-conformance.md`, formatRenderSafetyMarkdown(report), "Markdown");
  writeArtifact(`${outDir}/render-safety-conformance.junit.xml`, formatRenderSafetyJUnit(report), "JUnit XML");
  writeArtifact(`${outDir}/render-safety-conformance.sarif.json`, formatRenderSafetySarif(report), "SARIF");
}
