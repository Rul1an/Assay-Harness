/**
 * Assay-Runner archive recognition + Tier-1 validation for Assay-Harness.
 *
 * Phase 2D Tier 1 scope (see Rul1an/Assay-Harness#58):
 *
 *   H1 — recognise an Assay-Runner measured-run archive (`.tar.gz` with
 *        an `assay.runner.archive_manifest.v0` manifest at `manifest.json`),
 *        verify file list + per-file SHA-256 + per-file byte count.
 *   H2 — honest-health gate: reject archives where `observation_health`
 *        reports a degraded kernel layer, ring-buffer drops, a non-clean
 *        correlation status, or a non-clean cgroup correlation, unless the
 *        caller explicitly opts in to degraded acceptance.
 *   H6 — mode detection: classify an input path as either NDJSON evidence,
 *        a Runner archive, or unknown, without taking any other action.
 *
 * Tier 1 does NOT do structural comparison of two Runner archives. That is
 * Tier 2 (capability-surface diff + per-layer regression projection) and is
 * tracked separately in Rul1an/Assay-Harness#58.
 *
 * The schema string constants and archive layout mirror
 * `Rul1an/assay/crates/assay-runner-schema/src/archive_manifest.rs`
 * pinned at commit cd242666 on main. No new npm dependency is introduced;
 * tar.gz reading uses node:zlib for gunzip and a minimal in-file ustar
 * parser since Runner archives are produced with deterministic ustar
 * headers (no PAX, no GNU long-name extensions).
 *
 * This module is read-only. It never writes, modifies, or extracts archive
 * contents to disk.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Schema string constants — must match Runner side exactly
// ---------------------------------------------------------------------------

export const RUNNER_ARCHIVE_MANIFEST_SCHEMA = "assay.runner.archive_manifest.v0";
export const RUNNER_OBSERVATION_HEALTH_SCHEMA = "assay.runner.observation_health.v0";
export const RUNNER_CORRELATION_REPORT_SCHEMA = "assay.runner.correlation_report.v0";

// Path constants for the canonical archive layout.
export const RUNNER_MANIFEST_PATH = "manifest.json";
export const RUNNER_OBSERVATION_HEALTH_PATH = "observation-health.json";
export const RUNNER_CORRELATION_REPORT_PATH = "correlation-report.json";
export const RUNNER_CAPABILITY_SURFACE_PATH = "capability-surface.json";
export const RUNNER_EVENTS_PATH = "events.ndjson";
export const RUNNER_KERNEL_LAYER_PATH = "layers/kernel.ndjson";
export const RUNNER_POLICY_LAYER_PATH = "layers/policy.ndjson";
export const RUNNER_SDK_LAYER_PATH = "layers/sdk.ndjson";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunnerArchiveFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RunnerArchiveManifest {
  schema: string;
  run_id: string;
  files: Record<string, RunnerArchiveFileEntry>;
}

export interface RunnerObservationHealth {
  schema: string;
  run_id: string;
  platform: string;
  kernel_layer: string;
  ringbuf_drops: number;
  policy_layer: string;
  sdk_layer: string;
  cgroup_correlation: string;
  notes: string[];
}

export interface RunnerCorrelationReport {
  schema: string;
  run_id: string;
  status: string;
  bindings: unknown[];
  ambiguities: string[];
}

/**
 * Structured validation error from H1 (manifest/digest validation) or H2
 * (honest-health gate). `code` is a stable identifier suitable for CI
 * routing; `message` is human-readable.
 */
export interface RunnerValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface RunnerArchiveValidation {
  /** Recognised as a Runner archive by mode detection and tar/gzip parse. */
  recognised: boolean;
  /** All H1 manifest and digest checks passed. */
  manifest_valid: boolean;
  /** H1 + H2 errors. Empty array means clean. */
  errors: RunnerValidationError[];
  manifest?: RunnerArchiveManifest;
  observation_health?: RunnerObservationHealth;
  correlation_report?: RunnerCorrelationReport;
}

/** Caller-controlled options for the honest-health gate. */
export interface HonestHealthOptions {
  /**
   * Accept archives whose `observation_health` reports degraded measurement
   * (incomplete kernel layer, ring-buffer drops, non-clean correlation, or
   * non-clean cgroup correlation). Defaults to `false`.
   */
  allow_degraded?: boolean;
}

export interface HonestHealthVerdict {
  passed: boolean;
  /** Reasons for failure; empty if `passed` is true. */
  reasons: string[];
}

export type InputMode = "ndjson_evidence" | "runner_archive" | "unknown";

// ---------------------------------------------------------------------------
// Mode detection (H6)
// ---------------------------------------------------------------------------

/**
 * Classify an input file path without taking any other action.
 *
 * - `.ndjson` or `.jsonl` extension                 -> `ndjson_evidence`
 * - `.tar.gz` extension with a Runner manifest      -> `runner_archive`
 * - anything else                                   -> `unknown`
 *
 * For `.tar.gz` candidates, the function reads only enough of the archive
 * to locate and parse `manifest.json` and confirm the manifest schema
 * string. A `.tar.gz` that is not a Runner archive returns `unknown`,
 * not `runner_archive`.
 */
export function detectInputMode(filePath: string): InputMode {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) {
    return "ndjson_evidence";
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    try {
      const files = readTarGz(filePath);
      const manifestBytes = files.get(RUNNER_MANIFEST_PATH);
      if (!manifestBytes) return "unknown";
      const manifest = safeJsonParse<{ schema?: unknown }>(manifestBytes);
      if (!manifest) return "unknown";
      if (manifest.schema === RUNNER_ARCHIVE_MANIFEST_SCHEMA) {
        return "runner_archive";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// H1 — Manifest + digest validation
// ---------------------------------------------------------------------------

/**
 * Validate a Runner archive against its own manifest.
 *
 * Checks performed:
 *
 * - the archive is a valid gzip-compressed ustar tar
 * - `manifest.json` is present and parses as JSON
 * - `manifest.schema` equals `assay.runner.archive_manifest.v0`
 * - `manifest.run_id` is a non-empty string
 * - every entry in `manifest.files` is present in the archive
 * - every present file's SHA-256 matches the manifest's recorded digest
 * - every present file's byte count matches the manifest's recorded bytes
 *
 * Does NOT check the contents of `observation-health.json` or
 * `correlation-report.json` against any policy — that is `checkHonestHealth`
 * (H2). Does NOT diff the archive against a baseline — that is Tier 2.
 *
 * On success, the returned validation object carries the parsed manifest
 * plus, if present, the parsed observation-health and correlation-report
 * payloads for downstream use by `checkHonestHealth`.
 *
 * Throws only on filesystem errors (file not found, permission denied).
 * Structural errors are returned as `RunnerValidationError[]` so callers
 * can decide how to surface them.
 */
export function validateRunnerArchive(filePath: string): RunnerArchiveValidation {
  const errors: RunnerValidationError[] = [];

  // Step 1: read and gunzip + untar.
  let files: Map<string, Buffer>;
  try {
    files = readTarGz(filePath);
  } catch (err) {
    return {
      recognised: false,
      manifest_valid: false,
      errors: [
        {
          code: "ARCHIVE_UNREADABLE",
          message: `Failed to read archive as gzip-compressed tar: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }

  // Step 2: locate and parse manifest.
  const manifestBytes = files.get(RUNNER_MANIFEST_PATH);
  if (!manifestBytes) {
    return {
      recognised: false,
      manifest_valid: false,
      errors: [
        {
          code: "MANIFEST_MISSING",
          message: `Archive is missing required file: ${RUNNER_MANIFEST_PATH}`,
        },
      ],
    };
  }
  const manifest = safeJsonParse<RunnerArchiveManifest>(manifestBytes);
  if (!manifest) {
    return {
      recognised: false,
      manifest_valid: false,
      errors: [
        {
          code: "MANIFEST_NOT_JSON",
          message: `${RUNNER_MANIFEST_PATH} is not valid JSON`,
        },
      ],
    };
  }

  // Step 3: validate manifest shape.
  if (manifest.schema !== RUNNER_ARCHIVE_MANIFEST_SCHEMA) {
    return {
      recognised: false,
      manifest_valid: false,
      errors: [
        {
          code: "MANIFEST_SCHEMA_MISMATCH",
          message: `Expected schema ${RUNNER_ARCHIVE_MANIFEST_SCHEMA}; got ${
            typeof manifest.schema === "string"
              ? JSON.stringify(manifest.schema)
              : "(missing)"
          }`,
        },
      ],
    };
  }
  // Past this point we recognise the archive as a Runner archive.
  if (typeof manifest.run_id !== "string" || manifest.run_id.length === 0) {
    errors.push({
      code: "MANIFEST_RUN_ID_INVALID",
      message: "manifest.run_id must be a non-empty string",
    });
  }
  if (!manifest.files || typeof manifest.files !== "object") {
    errors.push({
      code: "MANIFEST_FILES_MISSING",
      message: "manifest.files must be an object mapping path to entry",
    });
    return {
      recognised: true,
      manifest_valid: false,
      errors,
      manifest,
    };
  }

  // Step 4: verify every manifest entry's presence, bytes, and SHA-256.
  for (const [entryPath, entry] of Object.entries(manifest.files)) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      typeof entry.bytes !== "number"
    ) {
      errors.push({
        code: "MANIFEST_ENTRY_MALFORMED",
        message: `manifest.files[${JSON.stringify(entryPath)}] is malformed`,
        path: entryPath,
      });
      continue;
    }
    if (entry.path !== entryPath) {
      errors.push({
        code: "MANIFEST_ENTRY_PATH_MISMATCH",
        message: `manifest.files key ${JSON.stringify(entryPath)} does not match entry.path ${JSON.stringify(entry.path)}`,
        path: entryPath,
      });
    }
    const actualBytes = files.get(entryPath);
    if (!actualBytes) {
      errors.push({
        code: "FILE_MISSING",
        message: `Manifest references ${entryPath}, but the archive does not contain it`,
        path: entryPath,
      });
      continue;
    }
    if (actualBytes.byteLength !== entry.bytes) {
      errors.push({
        code: "FILE_BYTES_MISMATCH",
        message: `File ${entryPath}: manifest says ${entry.bytes} bytes, archive contains ${actualBytes.byteLength} bytes`,
        path: entryPath,
      });
    }
    const actualSha = createHash("sha256").update(actualBytes).digest("hex");
    if (actualSha !== entry.sha256) {
      errors.push({
        code: "FILE_DIGEST_MISMATCH",
        message: `File ${entryPath}: manifest sha256=${entry.sha256}, archive sha256=${actualSha}`,
        path: entryPath,
      });
    }
  }

  // Step 5: parse the two artifacts honest-health depends on, if present.
  // It is not an H1 error if these are absent; H2 will report missingness.
  let observation_health: RunnerObservationHealth | undefined;
  const obsBytes = files.get(RUNNER_OBSERVATION_HEALTH_PATH);
  if (obsBytes) {
    const parsed = safeJsonParse<RunnerObservationHealth>(obsBytes);
    if (parsed && parsed.schema === RUNNER_OBSERVATION_HEALTH_SCHEMA) {
      observation_health = parsed;
    } else if (parsed) {
      errors.push({
        code: "OBSERVATION_HEALTH_SCHEMA_MISMATCH",
        message: `Expected schema ${RUNNER_OBSERVATION_HEALTH_SCHEMA}; got ${
          typeof parsed.schema === "string"
            ? JSON.stringify(parsed.schema)
            : "(missing)"
        }`,
        path: RUNNER_OBSERVATION_HEALTH_PATH,
      });
    } else {
      errors.push({
        code: "OBSERVATION_HEALTH_NOT_JSON",
        message: `${RUNNER_OBSERVATION_HEALTH_PATH} is not valid JSON`,
        path: RUNNER_OBSERVATION_HEALTH_PATH,
      });
    }
  }

  let correlation_report: RunnerCorrelationReport | undefined;
  const corrBytes = files.get(RUNNER_CORRELATION_REPORT_PATH);
  if (corrBytes) {
    const parsed = safeJsonParse<RunnerCorrelationReport>(corrBytes);
    if (parsed && parsed.schema === RUNNER_CORRELATION_REPORT_SCHEMA) {
      correlation_report = parsed;
    } else if (parsed) {
      errors.push({
        code: "CORRELATION_REPORT_SCHEMA_MISMATCH",
        message: `Expected schema ${RUNNER_CORRELATION_REPORT_SCHEMA}; got ${
          typeof parsed.schema === "string"
            ? JSON.stringify(parsed.schema)
            : "(missing)"
        }`,
        path: RUNNER_CORRELATION_REPORT_PATH,
      });
    } else {
      errors.push({
        code: "CORRELATION_REPORT_NOT_JSON",
        message: `${RUNNER_CORRELATION_REPORT_PATH} is not valid JSON`,
        path: RUNNER_CORRELATION_REPORT_PATH,
      });
    }
  }

  return {
    recognised: true,
    manifest_valid: errors.length === 0,
    errors,
    manifest,
    observation_health,
    correlation_report,
  };
}

// ---------------------------------------------------------------------------
// H2 — Honest-health gate
// ---------------------------------------------------------------------------

/**
 * Apply the honest-health gate to a validated Runner archive.
 *
 * Required-clean fields:
 *
 * - `observation_health.kernel_layer === "complete"`
 * - `observation_health.ringbuf_drops === 0`
 * - `observation_health.cgroup_correlation === "clean"`
 * - `correlation_report.status === "clean"`
 *
 * If `observation-health.json` or `correlation-report.json` is absent the
 * gate fails, because honest-health cannot be confirmed.
 *
 * The `sdk_layer` field is intentionally NOT gated: the v0 contract states
 * that SDK events are self-reported and never kernel-corroborated, so a
 * value of `self_reported` is the expected clean reading. The `policy_layer`
 * field is also not gated because `present`/`absent` is policy-dependent and
 * not a measurement-honesty concern.
 *
 * When `allow_degraded` is true, the gate returns `passed: true` regardless
 * of the values above; the reasons array still records what would have
 * failed so callers can log it.
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

  const passed = options.allow_degraded === true || reasons.length === 0;
  return { passed, reasons };
}

// ---------------------------------------------------------------------------
// Internal helpers — tar.gz reading + JSON parsing
// ---------------------------------------------------------------------------

/**
 * Read a `.tar.gz` from disk and return a Map of in-archive path -> bytes.
 *
 * Only regular files (typeflag `0` or `\0`) are returned. Directories,
 * symlinks, and other entries are ignored. The reader handles standard
 * ustar headers; PAX/GNU long-name extensions are not supported because
 * Runner archives are produced with deterministic ustar mode and short
 * paths well below the 100-byte limit (see
 * `Rul1an/assay/crates/assay-runner-core/src/archive.rs`).
 */
function readTarGz(filePath: string): Map<string, Buffer> {
  const compressed = readFileSync(filePath);
  const decompressed = gunzipSync(compressed);
  return parseTar(decompressed);
}

function parseTar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const BLOCK = 512;
  let offset = 0;

  while (offset + BLOCK <= buf.byteLength) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (isAllZero(header)) {
      // End-of-archive sentinel (two zero blocks per spec; one is enough to stop).
      break;
    }

    const name = readNullTerminated(header, 0, 100);
    const sizeField = readNullTerminated(header, 124, 12).trim();
    if (sizeField.length === 0) {
      throw new Error(`tar header at offset ${offset} has empty size field`);
    }
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`tar header at offset ${offset} has invalid size: ${sizeField}`);
    }
    const typeflagByte = header[156];
    const typeflag = typeflagByte === 0 ? "0" : String.fromCharCode(typeflagByte);

    offset += BLOCK;

    if (typeflag === "0" || typeflag === "\0") {
      if (offset + size > buf.byteLength) {
        throw new Error(`tar entry ${name} extends past end of buffer`);
      }
      const data = Buffer.from(buf.subarray(offset, offset + size));
      if (name.length > 0) {
        files.set(name, data);
      }
    }
    // Advance past the file body, padded to a block boundary.
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    offset += padded;
  }

  return files;
}

function readNullTerminated(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nullIdx = slice.indexOf(0);
  const end = nullIdx === -1 ? slice.byteLength : nullIdx;
  return slice.subarray(0, end).toString("utf8");
}

function isAllZero(buf: Buffer): boolean {
  for (let i = 0; i < buf.byteLength; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function safeJsonParse<T>(bytes: Buffer): T | null {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    return null;
  }
}
