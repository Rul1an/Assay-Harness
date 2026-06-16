/**
 * Conformance carrier gate — `assay.token_passthrough_conformance.v0` adapter.
 *
 * Consumer-not-owner. The producer (`Rul1an/assay`, `crates/assay-mcp-server/src/token_passthrough.rs`)
 * reports, value-free, that the consuming path does not re-emit a consumed inbound
 * authentication value on its outbound channels (transport headers, JSON body, spawned
 * env). The Harness validates the frozen v0 shape, gates CI on the producer-reported
 * per-channel facts, and projects Markdown / JUnit / SARIF.
 *
 * Gate: clean iff every CHECKED outbound channel reports `leak_count == 0` and is not
 * `pass == false`. Channels marked `not_applicable` are out of scope and skipped. The
 * transparent relay is recorded but is out of scope (it consumes no inbound auth).
 *
 * Scope: this is the confused-deputy boundary (consumed inbound auth not re-emitted) only.
 * It is NOT a scrub of arbitrary credential-shaped user payload, not a check of provider
 * token grants, and not token lifecycle / rotation / vaulting.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";

export const TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA = "assay.token_passthrough_conformance.v0";

export interface ProbedSource {
  source: string;
  probed: boolean;
  consumed: boolean;
}

export interface OutboundChannel {
  channel: string;
  checked: boolean;
  not_applicable?: boolean;
  leak_count: number;
  pass?: boolean;
}

export interface TokenPassthroughCarrier {
  schema: string;
  topology: string;
  probed_inbound_auth_sources: ProbedSource[];
  outbound_channels: OutboundChannel[];
  transparent_relay: { in_scope: boolean; reason: string };
  non_claims: string[];
}

export interface CarrierValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface TokenPassthroughValidation {
  valid: boolean;
  errors: CarrierValidationError[];
  carrier?: TokenPassthroughCarrier;
}

export interface ChannelResult {
  channel: OutboundChannel;
  /** Producer-reported issue on a checked channel, or null when clean / out of scope. */
  issue: string | null;
}

export interface TokenPassthroughReport {
  carrier_path: string;
  validation: TokenPassthroughValidation;
  /** `true` iff the carrier validated and no checked outbound channel leaked or failed. */
  passed: boolean;
  channels: ChannelResult[];
}

export class TokenPassthroughProjectionError extends Error {
  readonly kind: "ci_formatter";
  constructor(message: string) {
    super(message);
    this.name = "TokenPassthroughProjectionError";
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

export function validateTokenPassthroughConformance(raw: unknown): TokenPassthroughValidation {
  const errors: CarrierValidationError[] = [];

  if (!isRecord(raw)) {
    return {
      valid: false,
      errors: [{ code: "CARRIER_NOT_OBJECT", message: "token-passthrough carrier must be a JSON object" }],
    };
  }
  if (raw.schema !== TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA) {
    return {
      valid: false,
      errors: [
        {
          code: "CARRIER_SCHEMA_MISMATCH",
          message: `Expected schema ${TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA}; got ${
            raw.schema === undefined ? "(missing)" : JSON.stringify(raw.schema)
          }`,
          path: "schema",
        },
      ],
    };
  }

  if (!isNonEmptyString(raw.topology)) {
    errors.push({ code: "CARRIER_TOPOLOGY_INVALID", message: "topology must be a non-empty string", path: "topology" });
  }

  if (!Array.isArray(raw.probed_inbound_auth_sources)) {
    errors.push({
      code: "CARRIER_SOURCES_INVALID",
      message: "probed_inbound_auth_sources must be an array",
      path: "probed_inbound_auth_sources",
    });
  } else {
    raw.probed_inbound_auth_sources.forEach((s: unknown, i: number) => {
      const path = `probed_inbound_auth_sources[${i}]`;
      if (!isRecord(s) || !isNonEmptyString(s.source) || typeof s.probed !== "boolean" || typeof s.consumed !== "boolean") {
        errors.push({
          code: "CARRIER_SOURCE_SHAPE_INVALID",
          message: `${path} must be { source: string, probed: boolean, consumed: boolean }`,
          path,
        });
      }
    });
  }

  if (!Array.isArray(raw.outbound_channels) || raw.outbound_channels.length === 0) {
    errors.push({
      code: "CARRIER_CHANNELS_INVALID",
      message: "outbound_channels must be a non-empty array",
      path: "outbound_channels",
    });
  } else {
    raw.outbound_channels.forEach((c: unknown, i: number) => {
      const path = `outbound_channels[${i}]`;
      if (!isRecord(c)) {
        errors.push({ code: "CARRIER_CHANNEL_SHAPE_INVALID", message: `${path} must be an object`, path });
        return;
      }
      if (!isNonEmptyString(c.channel)) {
        errors.push({ code: "CARRIER_CHANNEL_FIELD_INVALID", message: `${path}.channel must be a non-empty string`, path: `${path}.channel` });
      }
      if (typeof c.checked !== "boolean") {
        errors.push({ code: "CARRIER_CHANNEL_FIELD_INVALID", message: `${path}.checked must be a boolean`, path: `${path}.checked` });
      }
      if (!isNonNegativeInteger(c.leak_count)) {
        errors.push({ code: "CARRIER_CHANNEL_FIELD_INVALID", message: `${path}.leak_count must be a non-negative integer`, path: `${path}.leak_count` });
      }
      if (c.not_applicable !== undefined && typeof c.not_applicable !== "boolean") {
        errors.push({ code: "CARRIER_CHANNEL_FIELD_INVALID", message: `${path}.not_applicable must be a boolean when present`, path: `${path}.not_applicable` });
      }
      if (c.pass !== undefined && typeof c.pass !== "boolean") {
        errors.push({ code: "CARRIER_CHANNEL_FIELD_INVALID", message: `${path}.pass must be a boolean when present`, path: `${path}.pass` });
      }
    });
  }

  if (!isRecord(raw.transparent_relay) || typeof raw.transparent_relay.in_scope !== "boolean" || !isNonEmptyString(raw.transparent_relay.reason)) {
    errors.push({
      code: "CARRIER_TRANSPARENT_RELAY_INVALID",
      message: "transparent_relay must be { in_scope: boolean, reason: string }",
      path: "transparent_relay",
    });
  }

  if (!isStringArray(raw.non_claims)) {
    errors.push({ code: "CARRIER_NON_CLAIMS_INVALID", message: "non_claims must be an array of strings", path: "non_claims" });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors, carrier: raw as unknown as TokenPassthroughCarrier };
}

/** Producer-reported issue on a checked channel, or null when clean / out of scope. */
export function channelIssue(c: OutboundChannel): string | null {
  if (c.not_applicable === true) return null; // out of scope
  if (!c.checked) return null; // not asserted by the producer
  if (c.leak_count > 0) return `leak_count=${c.leak_count}`;
  if (c.pass === false) return "pass=false";
  return null;
}

export function buildTokenPassthroughReport(carrierPath: string): TokenPassthroughReport {
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
      channels: [],
    };
  }

  const validation = validateTokenPassthroughConformance(parsed);
  if (!validation.valid || !validation.carrier) {
    return { carrier_path: carrierPath, validation, passed: false, channels: [] };
  }

  const channels = validation.carrier.outbound_channels.map((c) => ({ channel: c, issue: channelIssue(c) }));
  const passed = channels.every((c) => c.issue === null);
  return { carrier_path: carrierPath, validation, passed, channels };
}

export interface TokenPassthroughLoadResult {
  ok: boolean;
  not_found?: boolean;
  report?: TokenPassthroughReport;
}

export function loadTokenPassthroughReport(carrierPath: string): TokenPassthroughLoadResult {
  if (!carrierPath || !existsSync(carrierPath)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, report: buildTokenPassthroughReport(carrierPath) };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function statusLine(report: TokenPassthroughReport): string {
  if (!report.validation.valid) return "TOKEN-PASSTHROUGH CARRIER INVALID";
  return report.passed ? "OK" : "TOKEN-PASSTHROUGH CONFORMANCE NOT CLEAN";
}

export function formatTokenPassthroughSummary(report: TokenPassthroughReport): string {
  const leaked = report.channels.filter((c) => c.issue !== null).length;
  return [
    "[carrier-token-passthrough] schema: assay.token_passthrough_conformance.v0",
    `[carrier-token-passthrough] status: ${statusLine(report)}`,
    `[carrier-token-passthrough] outbound_channels: ${report.channels.length} (with_issue=${leaked})`,
    `[carrier-token-passthrough] artifact: ${report.carrier_path}`,
  ].join("\n");
}

export function formatTokenPassthroughMarkdown(report: TokenPassthroughReport): string {
  const lines: string[] = [];
  lines.push("# Token-Passthrough Conformance Carrier Gate");
  lines.push("");
  lines.push(`**Status:** ${statusLine(report)}`);
  lines.push(`**Schema:** \`${TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA}\``);
  lines.push(`**Carrier:** \`${report.carrier_path}\``);
  lines.push("");
  lines.push("> This gate surfaces the producer-reported per-channel facts: a consumed inbound");
  lines.push("> authentication value is not re-emitted on a checked outbound channel. It covers the");
  lines.push("> confused-deputy boundary only, not arbitrary payload scrubbing, provider token");
  lines.push("> grants, or token lifecycle / rotation / vaulting.");
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

  const carrier = report.validation.carrier as TokenPassthroughCarrier;
  lines.push(`- Topology: \`${carrier.topology}\``);
  lines.push(`- Transparent relay in scope: \`${carrier.transparent_relay.in_scope}\``);
  lines.push("");
  lines.push("| Outbound channel | Checked | Not applicable | Leak count | Pass |");
  lines.push("| --- | --- | --- | ---: | --- |");
  for (const { channel: c } of report.channels) {
    lines.push(
      `| ${c.channel} | ${c.checked} | ${c.not_applicable ?? false} | ${c.leak_count} | ${c.pass ?? "n/a"} |`,
    );
  }
  lines.push("");

  const leaked = report.channels.filter((c) => c.issue !== null);
  if (leaked.length > 0) {
    lines.push("## Channels the carrier reports as not clean");
    lines.push("");
    for (const l of leaked) lines.push(`- \`${l.channel.channel}\`: ${l.issue}`);
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

export function formatTokenPassthroughJUnit(report: TokenPassthroughReport): string {
  const cases = report.channels.map((c) => ({
    name: c.channel.channel,
    failure: c.issue !== null,
    message: c.issue !== null ? `${c.channel.channel}: ${c.issue}` : "",
  }));
  const failures = cases.filter((c) => c.failure).length;
  const body = cases
    .map((c) => {
      const open = `    <testcase classname="assay.token_passthrough_conformance" name="${xmlEscape(c.name)}" time="0">`;
      if (!c.failure) return `${open}</testcase>\n`;
      return [
        open,
        `      <failure message="${xmlEscape(c.message)}">${xmlEscape(c.message)}</failure>`,
        "    </testcase>",
        "",
      ].join("\n");
    })
    .join("");
  const summary = `status=${statusLine(report)} channels=${report.channels.length} with_issue=${failures}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `  <testsuite name="assay.token_passthrough_conformance" tests="${cases.length}" failures="${failures}" errors="0" skipped="0" time="0">`,
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
    id: "assay.carrier.token_passthrough.leak",
    name: "TokenPassthroughLeak",
    shortDescription: { text: "A consumed inbound auth value was re-emitted on a checked outbound channel" },
    fullDescription: {
      text: "A checked outbound channel reports a non-zero leak_count: the consuming path re-emitted a consumed inbound authentication value.",
    },
    defaultConfiguration: { level: "error" },
    properties: { "security-severity": "8.0" },
  },
  {
    id: "assay.carrier.token_passthrough.channel_failed",
    name: "TokenPassthroughChannelFailed",
    shortDescription: { text: "A checked outbound channel reports pass=false" },
    fullDescription: {
      text: "A checked outbound channel reports pass=false without a recorded leak count; the boundary check did not hold.",
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

export function formatTokenPassthroughSarif(report: TokenPassthroughReport): string {
  const uri = relativeUri(report.carrier_path);
  const results: unknown[] = [];

  for (const { channel: c, issue } of report.channels) {
    if (issue === null) continue;
    const ruleId =
      c.leak_count > 0 ? "assay.carrier.token_passthrough.leak" : "assay.carrier.token_passthrough.channel_failed";
    results.push({
      ruleId,
      level: "error",
      message: { text: `${c.channel}: ${issue}` },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }],
      partialFingerprints: { channel: c.channel },
      properties: { channel: c.channel, leak_count: c.leak_count },
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
                name: "assay-harness-token-passthrough-carrier",
                version: "0.8.0",
                informationUri: "https://github.com/Rul1an/Assay-Harness",
                rules: SARIF_RULES,
              },
            },
            results,
            automationDetails: { id: "assay-harness/token-passthrough-conformance/" },
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
    throw new TokenPassthroughProjectionError(
      `failed to write ${label} projection to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function writeTokenPassthroughProjections(report: TokenPassthroughReport, outDir: string): void {
  writeArtifact(`${outDir}/token-passthrough-conformance.md`, formatTokenPassthroughMarkdown(report), "Markdown");
  writeArtifact(`${outDir}/token-passthrough-conformance.junit.xml`, formatTokenPassthroughJUnit(report), "JUnit XML");
  writeArtifact(`${outDir}/token-passthrough-conformance.sarif.json`, formatTokenPassthroughSarif(report), "SARIF");
}
