/** Runner archive honest-health gate. */

import type { HonestHealthOptions, HonestHealthVerdict, RunnerArchiveValidation } from "./runner_archive.js";

const RUNNER_OBSERVATION_HEALTH_PATH = "observation-health.json";
const RUNNER_CORRELATION_REPORT_PATH = "correlation-report.json";

// ---------------------------------------------------------------------------
// H2 — Honest-health gate
// ---------------------------------------------------------------------------

/**
 * Reason-string prefixes that count as **measurement-health** reasons.
 * `allow_degraded` only bypasses these. Any other reason is structural
 * and must fail the gate regardless of `allow_degraded`.
 *
 * Exported so tests and downstream consumers can stay aligned with this
 * classification without re-encoding the list.
 */
export const MEASUREMENT_HEALTH_REASON_PREFIXES: readonly string[] = [
  "kernel_layer_not_complete:",
  "ringbuf_drops_nonzero:",
  "cgroup_correlation_not_clean:",
  "correlation_status_not_clean:",
];

function isMeasurementHealthReason(reason: string): boolean {
  return MEASUREMENT_HEALTH_REASON_PREFIXES.some((p) => reason.startsWith(p));
}

/**
 * Apply the honest-health gate to a validated Runner archive.
 *
 * Required-clean fields (measurement-health reasons):
 *
 * - `observation_health.kernel_layer === "complete"`
 * - `observation_health.ringbuf_drops === 0`
 * - `observation_health.cgroup_correlation === "clean"`
 * - `correlation_report.status === "clean"`
 *
 * Structural reasons (cannot be bypassed by `allow_degraded`):
 *
 * - archive not recognised as a Runner archive
 * - manifest or digest validation failed
 * - `observation-health.json` missing or malformed
 * - `correlation-report.json` missing or malformed
 *
 * The `sdk_layer` field is intentionally NOT gated: the v0 contract states
 * that SDK events are self-reported and never kernel-corroborated, so a
 * value of `self_reported` is the expected clean reading. The `policy_layer`
 * field is also not gated because `present`/`absent` is policy-dependent and
 * not a measurement-honesty concern.
 *
 * `checkHonestHealth` does not mutate the validation object and is safe to
 * call multiple times.
 */
export function checkHonestHealth(
  validation: RunnerArchiveValidation,
  options: HonestHealthOptions = {},
): HonestHealthVerdict {
  const reasons: string[] = [];

  if (!validation.recognised) {
    reasons.push("archive_not_recognised_as_runner_archive");
  }
  if (!validation.manifest_valid) {
    reasons.push("manifest_or_digest_validation_failed");
  }

  const oh = validation.observation_health;
  if (!oh) {
    reasons.push(`observation_health_missing_or_malformed:${RUNNER_OBSERVATION_HEALTH_PATH}`);
  } else {
    if (oh.kernel_layer !== "complete") {
      reasons.push(`kernel_layer_not_complete:${oh.kernel_layer}`);
    }
    if (typeof oh.ringbuf_drops !== "number" || oh.ringbuf_drops !== 0) {
      reasons.push(`ringbuf_drops_nonzero:${oh.ringbuf_drops}`);
    }
    if (oh.cgroup_correlation !== "clean") {
      reasons.push(`cgroup_correlation_not_clean:${oh.cgroup_correlation}`);
    }
  }

  const cr = validation.correlation_report;
  if (!cr) {
    reasons.push(`correlation_report_missing_or_malformed:${RUNNER_CORRELATION_REPORT_PATH}`);
  } else if (cr.status !== "clean") {
    reasons.push(`correlation_status_not_clean:${cr.status}`);
  }

  const measurement_health_reasons = reasons.filter(isMeasurementHealthReason);
  const structural_reasons = reasons.filter((r) => !isMeasurementHealthReason(r));

  // allow_degraded ONLY bypasses measurement-health reasons. Structural
  // reasons (recognition failure, manifest invalid, missing artifacts) are
  // integrity failures and always fail the gate.
  const passed =
    structural_reasons.length === 0 &&
    (options.allow_degraded === true || measurement_health_reasons.length === 0);

  return { passed, reasons, structural_reasons, measurement_health_reasons };
}
