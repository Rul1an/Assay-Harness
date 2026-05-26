/**
 * Tier 2B — per-layer reviewer projection over Runner measured-run archives.
 *
 * Scope (Rul1an/Assay-Harness#58 + Tier-2A refinement E):
 *
 *   Tier 2B reviewer projections are **explanatory only**. They MUST NOT
 *   be used as the canonical comparison output and MUST NOT introduce new
 *   gating semantics beyond Tier 2A. The Tier-2A regression flag is the
 *   single source of truth for whether a PR has a capability regression;
 *   the layer projection just helps a reviewer see where the surface diff
 *   came from.
 *
 * The projection parses the three layer ndjson streams from each archive
 * (`layers/kernel.ndjson`, `layers/policy.ndjson`, `layers/sdk.ndjson`),
 * computes per-layer summaries, and diffs them across baseline and
 * candidate at the **event-type histogram** level. For the SDK layer, the
 * projection additionally diffs the set of distinct `tool` values because
 * that field is guaranteed by the `assay.runner.sdk_event.v0` contract.
 *
 * The kernel layer has a published line schema (`assay.runner.kernel_event.v0`,
 * sidecar at `Rul1an/assay/docs/reference/runner/schema/kernel-event-v0.schema.json`)
 * with optional open metadata (`access_mode`, `operation_flags`,
 * `status`, `return_value`) since `Rul1an/assay#1362`. Tier-2B
 * deliberately keeps the conservative "count + event_type histogram"
 * projection for the kernel layer and ignores those optional fields; a
 * future follow-up can add an `access_mode`-aware (read / write /
 * create / truncate / append) projection if reviewer demand justifies
 * the surface area expansion. The policy layer does not yet have a
 * published v0 line schema, so the histogram view is the only option
 * there.
 *
 * The SDK layer is explicitly labelled as `self_reported` per the v0
 * contract: SDK events come from the agent runtime itself and are not
 * kernel-corroborated, so any claim derived from them must carry that
 * caveat.
 *
 * This module is read-only. Layer ndjson lines that fail to parse as JSON
 * are skipped silently; their count is reported in the summary so the
 * reviewer can see that some lines were unparseable without the
 * projection itself blocking on it.
 */

import { readRunnerArchiveFiles } from "./runner_archive.js";

// ---------------------------------------------------------------------------
// Constants — layer file paths inside Runner archives
// ---------------------------------------------------------------------------

export const RUNNER_LAYER_PATHS = {
  kernel: "layers/kernel.ndjson",
  policy: "layers/policy.ndjson",
  sdk: "layers/sdk.ndjson",
} as const;

export type RunnerLayerName = keyof typeof RUNNER_LAYER_PATHS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-side summary of one layer's ndjson stream.
 */
export interface RunnerLayerSummary {
  layer: RunnerLayerName;
  total_events: number;
  /**
   * Count of ndjson lines that failed JSON parse. Tier 2B does not block
   * on unparseable lines because the projection is explanatory only; the
   * count is surfaced so reviewers see when something is wrong with the
   * upstream emitter.
   */
  unparseable_lines: number;
  /**
   * Counts grouped by the event's `event_type` field if present, or by
   * `type` as a fallback. Events without either field are counted under
   * the synthetic key `"(unknown)"`.
   */
  event_types: Record<string, number>;
  /**
   * SDK-only: the set of distinct `tool` field values across all events.
   * Empty array for kernel and policy layers (not part of their summary).
   */
  sdk_tools?: string[];
  /**
   * Caveats for the reviewer. Notably: the SDK layer always carries the
   * `self_reported_per_v0_contract` note so any downstream UI surfaces it.
   */
  notes: string[];
}

/**
 * Diff of one layer between baseline and candidate. Explanatory only —
 * does not feed into the Tier-2A regression flag.
 */
export interface RunnerLayerDiff {
  layer: RunnerLayerName;
  baseline_total: number;
  candidate_total: number;
  total_delta: number;
  /** Event-type histograms (counts) before / after. */
  baseline_event_types: Record<string, number>;
  candidate_event_types: Record<string, number>;
  /** Event types present in the candidate but not in the baseline. */
  added_event_types: string[];
  /** Event types present in the baseline but not in the candidate. */
  removed_event_types: string[];
  /**
   * SDK-only: distinct tool names added / removed across runs. `undefined`
   * for kernel and policy layers.
   */
  sdk_tools?: {
    added: string[];
    removed: string[];
    baseline: string[];
    candidate: string[];
  };
  /** Aggregated notes (e.g. self-reported caveat for SDK). */
  notes: string[];
}

export interface RunnerLayerProjection {
  kernel: RunnerLayerDiff;
  policy: RunnerLayerDiff;
  sdk: RunnerLayerDiff;
  /**
   * `true` when, for every one of the three layers, at least one side
   * (baseline or candidate) provides the corresponding ndjson file. The
   * per-layer diffs are still emitted even when this is `false`; the flag
   * is informational so consumers can quickly tell whether the projection
   * is based on any input at all.
   *
   * This is intentionally lenient: Tier 2B is explanatory and surfaces
   * what it can. Stricter checks (e.g. both sides present, at least one
   * parseable line per layer) are not required because Tier 2B never
   * gates. Missing files per side are still surfaced via the per-layer
   * `notes` and the projection-level `notes` aggregate so a reviewer can
   * see the gap.
   */
  computed: boolean;
  /** Aggregated notes (one per affected layer/side that had issues). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Per-layer parsing + summarising
// ---------------------------------------------------------------------------

const SDK_NOTE_SELF_REPORTED =
  "sdk_layer_is_self_reported_per_v0_contract: events come from the SDK itself and are not kernel-corroborated";

function summariseLayer(
  layer: RunnerLayerName,
  bytes: Buffer | undefined,
): RunnerLayerSummary {
  const summary: RunnerLayerSummary = {
    layer,
    total_events: 0,
    unparseable_lines: 0,
    event_types: {},
    notes: [],
  };
  if (layer === "sdk") {
    summary.notes.push(SDK_NOTE_SELF_REPORTED);
    summary.sdk_tools = [];
  }
  if (!bytes) {
    summary.notes.push(`${layer}_layer_ndjson_missing`);
    return summary;
  }
  const text = bytes.toString("utf8");
  const sdkToolSet = layer === "sdk" ? new Set<string>() : null;
  // Iterate lines; ndjson uses LF separators with optional trailing newline.
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      summary.unparseable_lines += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      summary.unparseable_lines += 1;
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    summary.total_events += 1;
    const eventTypeRaw =
      typeof obj.event_type === "string"
        ? obj.event_type
        : typeof obj.type === "string"
          ? obj.type
          : "(unknown)";
    summary.event_types[eventTypeRaw] = (summary.event_types[eventTypeRaw] ?? 0) + 1;
    if (sdkToolSet && typeof obj.tool === "string" && obj.tool.length > 0) {
      sdkToolSet.add(obj.tool);
    }
  }
  if (sdkToolSet) {
    summary.sdk_tools = [...sdkToolSet].sort();
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

function diffStringSet(baseline: string[], candidate: string[]): {
  added: string[];
  removed: string[];
} {
  const baseSet = new Set(baseline);
  const candSet = new Set(candidate);
  const added = [...candSet].filter((x) => !baseSet.has(x)).sort();
  const removed = [...baseSet].filter((x) => !candSet.has(x)).sort();
  return { added, removed };
}

function diffEventTypeKeys(
  baseline: Record<string, number>,
  candidate: Record<string, number>,
): { added: string[]; removed: string[] } {
  return diffStringSet(Object.keys(baseline), Object.keys(candidate));
}

function diffLayer(
  baseline: RunnerLayerSummary,
  candidate: RunnerLayerSummary,
): RunnerLayerDiff {
  const typeKeys = diffEventTypeKeys(baseline.event_types, candidate.event_types);
  const layerNotes: string[] = [];
  // Carry forward the self-reported caveat into the diff so any consumer
  // sees it without having to introspect the source summary.
  if (baseline.layer === "sdk" || candidate.layer === "sdk") {
    layerNotes.push(SDK_NOTE_SELF_REPORTED);
  }
  if (baseline.unparseable_lines > 0) {
    layerNotes.push(`baseline_${baseline.layer}_unparseable_lines:${baseline.unparseable_lines}`);
  }
  if (candidate.unparseable_lines > 0) {
    layerNotes.push(`candidate_${candidate.layer}_unparseable_lines:${candidate.unparseable_lines}`);
  }
  const diff: RunnerLayerDiff = {
    layer: baseline.layer,
    baseline_total: baseline.total_events,
    candidate_total: candidate.total_events,
    total_delta: candidate.total_events - baseline.total_events,
    baseline_event_types: baseline.event_types,
    candidate_event_types: candidate.event_types,
    added_event_types: typeKeys.added,
    removed_event_types: typeKeys.removed,
    notes: layerNotes,
  };
  if (baseline.layer === "sdk") {
    const tools = diffStringSet(baseline.sdk_tools ?? [], candidate.sdk_tools ?? []);
    diff.sdk_tools = {
      added: tools.added,
      removed: tools.removed,
      baseline: baseline.sdk_tools ?? [],
      candidate: candidate.sdk_tools ?? [],
    };
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute a Tier-2B layer projection for two Runner archives.
 *
 * Reads each archive's `layers/{kernel,policy,sdk}.ndjson`, summarises
 * each layer, and diffs across baseline and candidate. Layers that are
 * missing on either side are still surfaced in the projection with empty
 * counts and a `*_layer_ndjson_missing` note so reviewers see the gap.
 *
 * This function does NOT validate the archives. The caller is expected to
 * run `validateRunnerArchive` + `checkHonestHealth` first (Tier 1) and
 * `compareRunnerArchivesCapabilitySurface` for the capability-surface
 * diff (Tier 2A). Tier 2B is supplementary.
 *
 * Throws only on filesystem errors. Malformed ndjson lines do not throw;
 * they are counted in `unparseable_lines` and skipped.
 */
export function computeLayerProjection(
  baselinePath: string,
  candidatePath: string,
): RunnerLayerProjection {
  const baseFiles = readRunnerArchiveFiles(baselinePath);
  const candFiles = readRunnerArchiveFiles(candidatePath);

  const layers: RunnerLayerName[] = ["kernel", "policy", "sdk"];
  const summaries: Record<RunnerLayerName, { baseline: RunnerLayerSummary; candidate: RunnerLayerSummary }> = {
    kernel: {
      baseline: summariseLayer("kernel", baseFiles.get(RUNNER_LAYER_PATHS.kernel)),
      candidate: summariseLayer("kernel", candFiles.get(RUNNER_LAYER_PATHS.kernel)),
    },
    policy: {
      baseline: summariseLayer("policy", baseFiles.get(RUNNER_LAYER_PATHS.policy)),
      candidate: summariseLayer("policy", candFiles.get(RUNNER_LAYER_PATHS.policy)),
    },
    sdk: {
      baseline: summariseLayer("sdk", baseFiles.get(RUNNER_LAYER_PATHS.sdk)),
      candidate: summariseLayer("sdk", candFiles.get(RUNNER_LAYER_PATHS.sdk)),
    },
  };

  const projection: RunnerLayerProjection = {
    kernel: diffLayer(summaries.kernel.baseline, summaries.kernel.candidate),
    policy: diffLayer(summaries.policy.baseline, summaries.policy.candidate),
    sdk: diffLayer(summaries.sdk.baseline, summaries.sdk.candidate),
    computed: layers.every(
      (l) =>
        baseFiles.has(RUNNER_LAYER_PATHS[l]) || candFiles.has(RUNNER_LAYER_PATHS[l]),
    ),
    notes: [],
  };

  for (const layer of layers) {
    for (const side of ["baseline", "candidate"] as const) {
      const s = summaries[layer][side];
      const missingNotes = s.notes.filter((n) => n.endsWith("_layer_ndjson_missing"));
      for (const n of missingNotes) {
        projection.notes.push(`${side}_${n}`);
      }
    }
  }

  return projection;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Render the layer projection as a reviewer-friendly markdown section.
 *
 * The section is meant to live below the Tier-2A capability-surface diff
 * in the same overall report. It does not stand on its own and does not
 * carry a Tier-2A regression flag of its own.
 */
export function formatRunnerLayerProjection(
  projection: RunnerLayerProjection,
): string {
  const lines: string[] = [];
  lines.push("## Per-Layer Projection (Tier 2B — reviewer UX, not a gate)");
  lines.push("");
  lines.push(
    "> Tier 2B is explanatory only. The Tier-2A capability-surface diff is",
  );
  lines.push("> the single source of truth for the regression flag and exit code.");
  lines.push("");

  if (projection.notes.length > 0) {
    lines.push("Notes:");
    for (const n of projection.notes) {
      lines.push(`- \`${n}\``);
    }
    lines.push("");
  }

  for (const layerKey of ["kernel", "policy", "sdk"] as const) {
    const d = projection[layerKey];
    const sign = d.total_delta > 0 ? "+" : "";
    lines.push(`### ${layerKey.toUpperCase()} layer`);
    lines.push("");
    lines.push(
      `- Events: baseline ${d.baseline_total} → candidate ${d.candidate_total} (delta ${sign}${d.total_delta})`,
    );
    if (d.added_event_types.length > 0) {
      lines.push("- Added event types:");
      for (const t of d.added_event_types) {
        lines.push(`  - \`${t}\``);
      }
    }
    if (d.removed_event_types.length > 0) {
      lines.push("- Removed event types:");
      for (const t of d.removed_event_types) {
        lines.push(`  - \`${t}\``);
      }
    }
    if (d.sdk_tools && (d.sdk_tools.added.length > 0 || d.sdk_tools.removed.length > 0)) {
      lines.push("- SDK tool names:");
      if (d.sdk_tools.added.length > 0) {
        lines.push("  - Added:");
        for (const t of d.sdk_tools.added) {
          lines.push(`    - \`${t}\``);
        }
      }
      if (d.sdk_tools.removed.length > 0) {
        lines.push("  - Removed:");
        for (const t of d.sdk_tools.removed) {
          lines.push(`    - \`${t}\``);
        }
      }
    }
    if (d.notes.length > 0) {
      lines.push("- Notes:");
      for (const n of d.notes) {
        lines.push(`  - \`${n}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
