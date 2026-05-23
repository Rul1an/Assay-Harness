/**
 * Baseline comparison for Assay Harness evidence files.
 *
 * Reads two NDJSON evidence files (baseline and candidate) and computes
 * regression dimensions: new/removed denials, new/removed approvals,
 * event count changes, type changes, hash mismatches, and process
 * summary deltas.
 *
 * Does NOT modify evidence. Read-only analysis only.
 */

import { readFileSync } from "node:fs";
import {
  checkHonestHealth,
  HonestHealthOptions,
  RunnerArchiveValidation,
  RunnerValidationError,
  validateRunnerArchive,
} from "./runner_archive.js";

// --- Types ---

interface EvidenceEvent {
  specversion: string;
  type: string;
  source: string;
  id: string;
  assayrunid: string;
  assayseq: number;
  assaycontenthash: string;
  data: Record<string, unknown>;
}

interface DenialKey {
  target_ref: string;
  policy_id: string;
}

interface ApprovalKey {
  target_ref: string;
  policy_id: string;
}

interface ProcessSummaryCounters {
  approval_count: number;
  denied_action_count: number;
  resume_count: number;
  allowed_action_count: number;
  total_tool_calls: number;
}

export interface ProcessSummaryDelta {
  field: string;
  baseline: number;
  candidate: number;
  delta: number;
}

export interface HashMismatch {
  type: string;
  assayseq: number;
  baseline_hash: string;
  candidate_hash: string;
}

export interface CompareResult {
  new_denials: DenialKey[];
  removed_denials: DenialKey[];
  new_approvals: ApprovalKey[];
  removed_approvals: ApprovalKey[];
  event_count_delta: number;
  new_event_types: string[];
  removed_event_types: string[];
  hash_mismatches: HashMismatch[];
  process_summary_delta: ProcessSummaryDelta[];
  has_regressions: boolean;
  summary: string;
}

// --- Parsing ---

function sortedStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(sortedStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k]));
  return "{" + pairs.join(",") + "}";
}

function parseNdjson(filePath: string): EvidenceEvent[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter((line) => line.length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as EvidenceEvent;
    } catch {
      throw new Error(`Invalid JSON at line ${i + 1} in ${filePath}`);
    }
  });
}

// --- Extraction helpers ---

/**
 * Extract denial keys from evidence events.
 * Handles both direct harness events and mapper-produced events with data.observed.
 */
function extractDenials(events: EvidenceEvent[]): DenialKey[] {
  const denials: DenialKey[] = [];
  for (const event of events) {
    const isDeniedAction =
      event.type === "assay.harness.denied-action" ||
      event.type === "example.placeholder.harness.denied-action";
    const isDenyDecision =
      event.type === "assay.harness.policy-decision" ||
      event.type === "example.placeholder.harness.policy-decision";

    if (isDeniedAction) {
      const d = (event.data.observed as Record<string, unknown>) ?? event.data;
      denials.push({
        target_ref: d.target_ref as string,
        policy_id: d.policy_id as string,
      });
    } else if (isDenyDecision) {
      const d = (event.data.observed as Record<string, unknown>) ?? event.data;
      if (d.decision === "deny") {
        denials.push({
          target_ref: d.target_ref as string,
          policy_id: d.policy_id as string,
        });
      }
    }
  }
  return denials;
}

/**
 * Extract approval keys from evidence events (require_approval decisions).
 */
function extractApprovals(events: EvidenceEvent[]): ApprovalKey[] {
  const approvals: ApprovalKey[] = [];
  for (const event of events) {
    const isDecision =
      event.type === "assay.harness.policy-decision" ||
      event.type === "example.placeholder.harness.policy-decision";

    if (isDecision) {
      const d = (event.data.observed as Record<string, unknown>) ?? event.data;
      if (d.decision === "require_approval") {
        approvals.push({
          target_ref: d.target_ref as string,
          policy_id: d.policy_id as string,
        });
      }
    }
  }
  return approvals;
}

/**
 * Extract process summary counters from the last process-summary event.
 */
function extractProcessSummary(events: EvidenceEvent[]): ProcessSummaryCounters | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const isSummary =
      event.type === "assay.harness.process-summary" ||
      event.type === "example.placeholder.harness.process-summary";

    if (isSummary) {
      const d = (event.data.observed as Record<string, unknown>) ?? event.data;
      return {
        approval_count: (d.approval_count as number) ?? 0,
        denied_action_count: (d.denied_action_count as number) ?? 0,
        resume_count: (d.resume_count as number) ?? 0,
        allowed_action_count: (d.allowed_action_count as number) ?? 0,
        total_tool_calls: (d.total_tool_calls as number) ?? 0,
      };
    }
  }
  return null;
}

/**
 * Collect unique event types from a list of events.
 */
function collectEventTypes(events: EvidenceEvent[]): Set<string> {
  return new Set(events.map((e) => e.type));
}

// --- Comparison helpers ---

function denialKeyString(k: DenialKey): string {
  return `${k.target_ref}|${k.policy_id}`;
}

function approvalKeyString(k: ApprovalKey): string {
  return `${k.target_ref}|${k.policy_id}`;
}

function diffKeys<T>(
  baseline: T[],
  candidate: T[],
  keyFn: (k: T) => string
): { added: T[]; removed: T[] } {
  const baseSet = new Set(baseline.map(keyFn));
  const candSet = new Set(candidate.map(keyFn));
  const added = candidate.filter((k) => !baseSet.has(keyFn(k)));
  const removed = baseline.filter((k) => !candSet.has(keyFn(k)));
  return { added, removed };
}

function computeHashMismatches(
  baseline: EvidenceEvent[],
  candidate: EvidenceEvent[]
): HashMismatch[] {
  const baseMap = new Map<string, string>();
  for (const event of baseline) {
    const key = `${event.type}|${event.assayseq}`;
    baseMap.set(key, event.assaycontenthash);
  }

  const mismatches: HashMismatch[] = [];
  for (const event of candidate) {
    const key = `${event.type}|${event.assayseq}`;
    const baseHash = baseMap.get(key);
    if (baseHash !== undefined && baseHash !== event.assaycontenthash) {
      mismatches.push({
        type: event.type,
        assayseq: event.assayseq,
        baseline_hash: baseHash,
        candidate_hash: event.assaycontenthash,
      });
    }
  }
  return mismatches;
}

function computeProcessSummaryDelta(
  baseline: ProcessSummaryCounters | null,
  candidate: ProcessSummaryCounters | null
): ProcessSummaryDelta[] {
  if (!baseline || !candidate) return [];

  const fields: (keyof ProcessSummaryCounters)[] = [
    "approval_count",
    "denied_action_count",
    "resume_count",
    "allowed_action_count",
    "total_tool_calls",
  ];

  const deltas: ProcessSummaryDelta[] = [];
  for (const field of fields) {
    const bVal = baseline[field];
    const cVal = candidate[field];
    if (bVal !== cVal) {
      deltas.push({
        field,
        baseline: bVal,
        candidate: cVal,
        delta: cVal - bVal,
      });
    }
  }
  return deltas;
}

// --- Main comparison ---

export function compareEvidence(baselinePath: string, candidatePath: string): CompareResult {
  const baselineEvents = parseNdjson(baselinePath);
  const candidateEvents = parseNdjson(candidatePath);

  // Denials
  const baseDenials = extractDenials(baselineEvents);
  const candDenials = extractDenials(candidateEvents);
  const denialDiff = diffKeys(baseDenials, candDenials, denialKeyString);

  // Approvals
  const baseApprovals = extractApprovals(baselineEvents);
  const candApprovals = extractApprovals(candidateEvents);
  const approvalDiff = diffKeys(baseApprovals, candApprovals, approvalKeyString);

  // Event count
  const eventCountDelta = candidateEvents.length - baselineEvents.length;

  // Event types
  const baseTypes = collectEventTypes(baselineEvents);
  const candTypes = collectEventTypes(candidateEvents);
  const newEventTypes = [...candTypes].filter((t) => !baseTypes.has(t)).sort();
  const removedEventTypes = [...baseTypes].filter((t) => !candTypes.has(t)).sort();

  // Hash mismatches
  const hashMismatches = computeHashMismatches(baselineEvents, candidateEvents);

  // Process summary delta
  const baseSummary = extractProcessSummary(baselineEvents);
  const candSummary = extractProcessSummary(candidateEvents);
  const processSummaryDelta = computeProcessSummaryDelta(baseSummary, candSummary);

  // Regression detection
  const increasedDeniedCount = processSummaryDelta.some(
    (d) => d.field === "denied_action_count" && d.delta > 0
  );
  const hasRegressions =
    denialDiff.added.length > 0 ||
    newEventTypes.length > 0 ||
    hashMismatches.length > 0 ||
    increasedDeniedCount;

  // Summary
  const parts: string[] = [];
  if (denialDiff.added.length > 0) {
    parts.push(`${denialDiff.added.length} new denial(s)`);
  }
  if (denialDiff.removed.length > 0) {
    parts.push(`${denialDiff.removed.length} removed denial(s)`);
  }
  if (approvalDiff.added.length > 0) {
    parts.push(`${approvalDiff.added.length} new approval(s)`);
  }
  if (approvalDiff.removed.length > 0) {
    parts.push(`${approvalDiff.removed.length} removed approval(s)`);
  }
  if (eventCountDelta !== 0) {
    parts.push(`event count delta: ${eventCountDelta > 0 ? "+" : ""}${eventCountDelta}`);
  }
  if (newEventTypes.length > 0) {
    parts.push(`${newEventTypes.length} new event type(s)`);
  }
  if (removedEventTypes.length > 0) {
    parts.push(`${removedEventTypes.length} removed event type(s)`);
  }
  if (hashMismatches.length > 0) {
    parts.push(`${hashMismatches.length} hash mismatch(es)`);
  }
  if (processSummaryDelta.length > 0) {
    parts.push(`${processSummaryDelta.length} process counter change(s)`);
  }
  const summary = parts.length > 0
    ? (hasRegressions ? "REGRESSION: " : "CHANGE: ") + parts.join(", ")
    : "No changes detected";

  return {
    new_denials: denialDiff.added,
    removed_denials: denialDiff.removed,
    new_approvals: approvalDiff.added,
    removed_approvals: approvalDiff.removed,
    event_count_delta: eventCountDelta,
    new_event_types: newEventTypes,
    removed_event_types: removedEventTypes,
    hash_mismatches: hashMismatches,
    process_summary_delta: processSummaryDelta,
    has_regressions: hasRegressions,
    summary,
  };
}

// --- Formatting ---

export function formatCompareResult(result: CompareResult): string {
  const lines: string[] = [];

  lines.push("# Evidence Comparison Report");
  lines.push("");
  lines.push(`**Status:** ${result.has_regressions ? "REGRESSION DETECTED" : "OK"}`);
  lines.push(`**Summary:** ${result.summary}`);
  lines.push("");

  // New denials
  if (result.new_denials.length > 0) {
    lines.push("## New Denials");
    lines.push("");
    for (const d of result.new_denials) {
      lines.push(`- \`${d.target_ref}\` (policy: ${d.policy_id})`);
    }
    lines.push("");
  }

  // Removed denials
  if (result.removed_denials.length > 0) {
    lines.push("## Removed Denials");
    lines.push("");
    for (const d of result.removed_denials) {
      lines.push(`- \`${d.target_ref}\` (policy: ${d.policy_id})`);
    }
    lines.push("");
  }

  // New approvals
  if (result.new_approvals.length > 0) {
    lines.push("## New Approvals");
    lines.push("");
    for (const a of result.new_approvals) {
      lines.push(`- \`${a.target_ref}\` (policy: ${a.policy_id})`);
    }
    lines.push("");
  }

  // Removed approvals
  if (result.removed_approvals.length > 0) {
    lines.push("## Removed Approvals");
    lines.push("");
    for (const a of result.removed_approvals) {
      lines.push(`- \`${a.target_ref}\` (policy: ${a.policy_id})`);
    }
    lines.push("");
  }

  // Event count delta
  if (result.event_count_delta !== 0) {
    lines.push("## Event Count");
    lines.push("");
    const sign = result.event_count_delta > 0 ? "+" : "";
    lines.push(`Delta: ${sign}${result.event_count_delta}`);
    lines.push("");
  }

  // Event type changes
  if (result.new_event_types.length > 0 || result.removed_event_types.length > 0) {
    lines.push("## Event Type Changes");
    lines.push("");
    for (const t of result.new_event_types) {
      lines.push(`- Added: \`${t}\``);
    }
    for (const t of result.removed_event_types) {
      lines.push(`- Removed: \`${t}\``);
    }
    lines.push("");
  }

  // Hash mismatches
  if (result.hash_mismatches.length > 0) {
    lines.push("## Hash Mismatches");
    lines.push("");
    for (const m of result.hash_mismatches) {
      lines.push(`- seq ${m.assayseq} (\`${m.type}\`)`);
      lines.push(`  - baseline: \`${m.baseline_hash}\``);
      lines.push(`  - candidate: \`${m.candidate_hash}\``);
    }
    lines.push("");
  }

  // Process summary delta
  if (result.process_summary_delta.length > 0) {
    lines.push("## Process Summary Delta");
    lines.push("");
    lines.push("| Counter | Baseline | Candidate | Delta |");
    lines.push("|---------|----------|-----------|-------|");
    for (const d of result.process_summary_delta) {
      const sign = d.delta > 0 ? "+" : "";
      lines.push(`| ${d.field} | ${d.baseline} | ${d.candidate} | ${sign}${d.delta} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runner archive Tier-1 comparison (H6 + H1 + H2)
//
// Phase 2D Tier 1 scope (see Rul1an/Assay-Harness#58): recognise a pair of
// Assay-Runner measured-run archives, validate each archive's manifest and
// per-file digests, and apply the honest-health gate. No structural diff
// across archives is performed; capability-surface diff and per-layer
// regression projection are Tier 2.
// ---------------------------------------------------------------------------

/** Per-side Tier-1 validation summary inside a Runner-mode compare result. */
export interface RunnerArchiveSideStatus {
  archive: string;
  recognised: boolean;
  manifest_valid: boolean;
  honest_health_passed: boolean;
  honest_health_reasons: string[];
  manifest_errors: RunnerValidationError[];
  run_id?: string;
}

/**
 * Result of a Tier-1 comparison of two Runner archives.
 *
 * Tier 1 only confirms that both archives parse, both manifests verify, and
 * both pass the honest-health gate. `tier2_diff_implemented` is always
 * `false` at Tier 1; a future Tier-2 PR will replace this with structural
 * surface/layer diff fields.
 *
 * `has_regressions` is true when **either** side fails manifest validation
 * or fails the honest-health gate (with `allow_degraded` not set on that
 * side). It does NOT compare the two archives against each other.
 */
export interface RunnerCompareTier1Result {
  mode: "runner_archive";
  baseline: RunnerArchiveSideStatus;
  candidate: RunnerArchiveSideStatus;
  tier2_diff_implemented: false;
  has_regressions: boolean;
  summary: string;
}

function buildSideStatus(
  archivePath: string,
  validation: RunnerArchiveValidation,
  options: HonestHealthOptions,
): RunnerArchiveSideStatus {
  const health = checkHonestHealth(validation, options);
  return {
    archive: archivePath,
    recognised: validation.recognised,
    manifest_valid: validation.manifest_valid,
    honest_health_passed: health.passed,
    honest_health_reasons: health.reasons,
    manifest_errors: validation.errors,
    run_id: validation.manifest?.run_id,
  };
}

export function compareRunnerArchivesTier1(
  baselinePath: string,
  candidatePath: string,
  options: HonestHealthOptions = {},
): RunnerCompareTier1Result {
  const baselineValidation = validateRunnerArchive(baselinePath);
  const candidateValidation = validateRunnerArchive(candidatePath);

  const baseline = buildSideStatus(baselinePath, baselineValidation, options);
  const candidate = buildSideStatus(candidatePath, candidateValidation, options);

  const baselineClean =
    baseline.recognised && baseline.manifest_valid && baseline.honest_health_passed;
  const candidateClean =
    candidate.recognised && candidate.manifest_valid && candidate.honest_health_passed;

  const parts: string[] = [];
  if (!baseline.recognised) parts.push("baseline not recognised as Runner archive");
  else if (!baseline.manifest_valid) parts.push("baseline manifest/digest invalid");
  else if (!baseline.honest_health_passed) parts.push("baseline honest-health degraded");
  if (!candidate.recognised) parts.push("candidate not recognised as Runner archive");
  else if (!candidate.manifest_valid) parts.push("candidate manifest/digest invalid");
  else if (!candidate.honest_health_passed) parts.push("candidate honest-health degraded");

  const tier1Clean = baselineClean && candidateClean;
  const summary = tier1Clean
    ? "TIER-1 OK: both Runner archives validated and honest-health clean; structural diff is Tier 2 (not implemented in this version)"
    : `TIER-1 FAIL: ${parts.join("; ")}`;

  return {
    mode: "runner_archive",
    baseline,
    candidate,
    tier2_diff_implemented: false,
    has_regressions: !tier1Clean,
    summary,
  };
}

export function formatRunnerCompareTier1Result(
  result: RunnerCompareTier1Result,
): string {
  const lines: string[] = [];
  lines.push("# Runner Archive Comparison (Tier 1)");
  lines.push("");
  lines.push(`**Status:** ${result.has_regressions ? "TIER-1 FAIL" : "TIER-1 OK"}`);
  lines.push(`**Summary:** ${result.summary}`);
  lines.push("");
  lines.push(
    "> Tier 1 validates each archive's manifest, digests, and honest-health.",
  );
  lines.push(
    "> Structural diff (capability surface, per-layer regressions) is Tier 2 and",
  );
  lines.push("> is not implemented in this version.");
  lines.push("");

  for (const side of [
    { label: "Baseline", status: result.baseline },
    { label: "Candidate", status: result.candidate },
  ]) {
    lines.push(`## ${side.label}`);
    lines.push("");
    lines.push(`- Archive: \`${side.status.archive}\``);
    lines.push(`- Recognised: ${side.status.recognised ? "yes" : "no"}`);
    lines.push(`- Manifest valid: ${side.status.manifest_valid ? "yes" : "no"}`);
    if (side.status.run_id) {
      lines.push(`- Run id: \`${side.status.run_id}\``);
    }
    lines.push(
      `- Honest health: ${side.status.honest_health_passed ? "passed" : "failed"}`,
    );
    if (side.status.manifest_errors.length > 0) {
      lines.push("- Manifest / digest errors:");
      for (const e of side.status.manifest_errors) {
        lines.push(`  - \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
      }
    }
    if (side.status.honest_health_reasons.length > 0) {
      lines.push("- Honest-health reasons:");
      for (const r of side.status.honest_health_reasons) {
        lines.push(`  - \`${r}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
