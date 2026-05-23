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
import { readFileSync, statSync } from "node:fs";
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
 * Structured validation error from H1 (manifest/digest validation) or from
 * the secondary parse of observation-health / correlation-report payloads.
 * `code` is a stable identifier suitable for CI routing; `message` is
 * human-readable.
 */
export interface RunnerValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface RunnerArchiveValidation {
  /** Recognised as a Runner archive (extension + manifest schema match). */
  recognised: boolean;
  /**
   * All strict H1 manifest, file-set, and digest checks passed. Does NOT
   * include observation-health / correlation-report payload parse errors;
   * those are reported in `artifact_parse_errors` and surface through the
   * honest-health gate instead of the manifest gate.
   */
  manifest_valid: boolean;
  /** H1 errors only: archive read, manifest shape, file-set, digests. */
  manifest_errors: RunnerValidationError[];
  /**
   * Errors from parsing the observation-health and correlation-report
   * payloads (missing schema string, malformed JSON, wrong schema). These
   * do NOT make the manifest invalid; they cause `observation_health` or
   * `correlation_report` to remain undefined, which the honest-health gate
   * then catches.
   */
  artifact_parse_errors: RunnerValidationError[];
  manifest?: RunnerArchiveManifest;
  observation_health?: RunnerObservationHealth;
  correlation_report?: RunnerCorrelationReport;
}

/** Caller-controlled options for the honest-health gate. */
export interface HonestHealthOptions {
  /**
   * Accept archives whose `observation_health` reports degraded measurement
   * (incomplete kernel layer, ring-buffer drops, non-clean cgroup
   * correlation, or non-clean correlation status). Defaults to `false`.
   *
   * `allow_degraded` ONLY bypasses measurement-health reasons. It does NOT
   * bypass structural reasons such as archive-not-recognised, manifest
   * invalid, or observation-health/correlation-report missing or
   * malformed. Those are integrity failures, not honest measurement of
   * degradation.
   */
  allow_degraded?: boolean;
}

export interface HonestHealthVerdict {
  passed: boolean;
  /** Reasons for failure; empty if `passed` is true. */
  reasons: string[];
  /**
   * Subset of `reasons` that are structural (cannot be bypassed by
   * `allow_degraded`). When non-empty, `passed` is always `false`
   * regardless of `allow_degraded`.
   */
  structural_reasons: string[];
  /**
   * Subset of `reasons` that report measurement degradation (bypassable by
   * `allow_degraded`). Recorded even when `allow_degraded` made the gate
   * pass, so callers can log what was accepted.
   */
  measurement_health_reasons: string[];
}

export type InputMode = "ndjson_evidence" | "runner_archive" | "unknown";

// ---------------------------------------------------------------------------
// Mode detection (H6)
// ---------------------------------------------------------------------------

/**
 * Classify an input file path purely by extension, without opening the file.
 *
 * - `.ndjson` or `.jsonl` -> `ndjson_evidence`
 * - `.tar.gz` or `.tgz`   -> `runner_archive`
 * - anything else         -> `unknown`
 *
 * Content validation is the validator's job, not the dispatcher's. A
 * `.tar.gz` whose body is corrupted, missing a Runner manifest, or carrying
 * a non-Runner manifest still classifies as `runner_archive` so that the
 * caller routes it to `validateRunnerArchive`, which then surfaces the
 * exact structural failure with a stable error code. That preserves the
 * documented exit-code routing (corrupted/non-Runner `.tar.gz` ->
 * artifact_contract (3), not config_error (2)).
 */
export function detectInputMode(filePath: string): InputMode {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) {
    return "ndjson_evidence";
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "runner_archive";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// H1 — Manifest + digest validation
// ---------------------------------------------------------------------------

/**
 * Maximum compressed archive size accepted by the validator. Larger files
 * are rejected with `ARCHIVE_TOO_LARGE` before any decompression work runs.
 * Real Runner archives are well under this bound (see proof packs in
 * `Rul1an/assay/docs/reference/runner/proof-packs/`).
 */
export const RUNNER_ARCHIVE_MAX_COMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MiB

/**
 * Maximum decompressed archive size accepted by the validator. Caps the
 * gunzip output to prevent zip-bomb-style memory exhaustion. Real Runner
 * archives are well under this bound.
 */
export const RUNNER_ARCHIVE_MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Parse a Runner manifest digest of the form `sha256:<64-hex>` into the
 * raw hex string. Returns `null` if the format is wrong.
 */
function parseManifestDigest(value: string): string | null {
  if (!value.startsWith("sha256:")) return null;
  const hex = value.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return hex;
}

/**
 * Validate a Runner archive against its own manifest.
 *
 * Strict H1 checks (failures recorded in `manifest_errors`, control
 * `manifest_valid`):
 *
 * - the archive is a valid gzip-compressed ustar tar within size limits
 * - `manifest.json` is present and parses as JSON
 * - `manifest.schema` equals `assay.runner.archive_manifest.v0`
 * - `manifest.run_id` is a non-empty string
 * - every entry in `manifest.files` is present in the archive
 * - every archive regular file (other than `manifest.json` itself, which
 *   the Rust writer does NOT include in its own files map) is listed in
 *   the manifest
 * - every present file's byte count matches `manifest.files[*].bytes`
 * - every present file's SHA-256 matches `manifest.files[*].sha256`,
 *   which must be in the form `sha256:<64-hex>` per the Rust writer in
 *   `crates/assay-runner-core/src/archive.rs`
 *
 * Secondary parse checks (failures recorded in `artifact_parse_errors`,
 * do NOT make `manifest_valid` false):
 *
 * - if `observation-health.json` is present, it parses as JSON and carries
 *   the v0 schema string. Otherwise the archive lacks an
 *   `observation_health` payload and the honest-health gate (H2) will fail
 *   on `observation_health_missing_or_malformed`.
 * - if `correlation-report.json` is present, it parses as JSON and carries
 *   the v0 schema string. Otherwise the honest-health gate will fail on
 *   `correlation_report_missing_or_malformed`.
 *
 * Tier-1 scope: does NOT diff the archive against a baseline.
 *
 * Throws only on filesystem errors (file not found, permission denied).
 * Structural errors are returned as `RunnerValidationError[]` so callers
 * can decide how to surface them.
 */
export function validateRunnerArchive(filePath: string): RunnerArchiveValidation {
  const manifest_errors: RunnerValidationError[] = [];
  const artifact_parse_errors: RunnerValidationError[] = [];

  // Step 1: read and gunzip + untar.
  let files: Map<string, Buffer>;
  try {
    files = readTarGz(filePath);
  } catch (err) {
    return {
      recognised: false,
      manifest_valid: false,
      manifest_errors: [
        {
          code: "ARCHIVE_UNREADABLE",
          message: `Failed to read archive as gzip-compressed tar: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
      artifact_parse_errors: [],
    };
  }

  // Step 2: locate and parse manifest.
  const manifestBytes = files.get(RUNNER_MANIFEST_PATH);
  if (!manifestBytes) {
    return {
      recognised: false,
      manifest_valid: false,
      manifest_errors: [
        {
          code: "MANIFEST_MISSING",
          message: `Archive is missing required file: ${RUNNER_MANIFEST_PATH}`,
        },
      ],
      artifact_parse_errors: [],
    };
  }
  const manifest = safeJsonParse<RunnerArchiveManifest>(manifestBytes);
  if (!manifest) {
    return {
      recognised: false,
      manifest_valid: false,
      manifest_errors: [
        {
          code: "MANIFEST_NOT_JSON",
          message: `${RUNNER_MANIFEST_PATH} is not valid JSON`,
        },
      ],
      artifact_parse_errors: [],
    };
  }

  // Step 3: validate manifest shape.
  if (manifest.schema !== RUNNER_ARCHIVE_MANIFEST_SCHEMA) {
    return {
      recognised: false,
      manifest_valid: false,
      manifest_errors: [
        {
          code: "MANIFEST_SCHEMA_MISMATCH",
          message: `Expected schema ${RUNNER_ARCHIVE_MANIFEST_SCHEMA}; got ${
            typeof manifest.schema === "string"
              ? JSON.stringify(manifest.schema)
              : "(missing)"
          }`,
        },
      ],
      artifact_parse_errors: [],
    };
  }
  // Past this point we recognise the archive as a Runner archive.
  if (typeof manifest.run_id !== "string" || manifest.run_id.length === 0) {
    manifest_errors.push({
      code: "MANIFEST_RUN_ID_INVALID",
      message: "manifest.run_id must be a non-empty string",
    });
  }
  if (!manifest.files || typeof manifest.files !== "object") {
    manifest_errors.push({
      code: "MANIFEST_FILES_MISSING",
      message: "manifest.files must be an object mapping path to entry",
    });
    return {
      recognised: true,
      manifest_valid: false,
      manifest_errors,
      artifact_parse_errors: [],
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
      manifest_errors.push({
        code: "MANIFEST_ENTRY_MALFORMED",
        message: `manifest.files[${JSON.stringify(entryPath)}] is malformed`,
        path: entryPath,
      });
      continue;
    }
    if (entry.path !== entryPath) {
      manifest_errors.push({
        code: "MANIFEST_ENTRY_PATH_MISMATCH",
        message: `manifest.files key ${JSON.stringify(entryPath)} does not match entry.path ${JSON.stringify(entry.path)}`,
        path: entryPath,
      });
    }
    const expectedHex = parseManifestDigest(entry.sha256);
    if (expectedHex === null) {
      manifest_errors.push({
        code: "MANIFEST_ENTRY_DIGEST_FORMAT_INVALID",
        message: `manifest.files[${JSON.stringify(entryPath)}].sha256 must be of the form 'sha256:<64-hex>'; got ${JSON.stringify(
          entry.sha256,
        )}`,
        path: entryPath,
      });
    }
    const actualBytes = files.get(entryPath);
    if (!actualBytes) {
      manifest_errors.push({
        code: "FILE_MISSING",
        message: `Manifest references ${entryPath}, but the archive does not contain it`,
        path: entryPath,
      });
      continue;
    }
    if (actualBytes.byteLength !== entry.bytes) {
      manifest_errors.push({
        code: "FILE_BYTES_MISMATCH",
        message: `File ${entryPath}: manifest says ${entry.bytes} bytes, archive contains ${actualBytes.byteLength} bytes`,
        path: entryPath,
      });
    }
    if (expectedHex !== null) {
      const actualHex = createHash("sha256").update(actualBytes).digest("hex");
      if (actualHex !== expectedHex) {
        manifest_errors.push({
          code: "FILE_DIGEST_MISMATCH",
          message: `File ${entryPath}: manifest sha256=sha256:${expectedHex}, archive sha256=sha256:${actualHex}`,
          path: entryPath,
        });
      }
    }
  }

  // Step 4b: reject archive entries that are not listed in the manifest.
  // The Rust writer does NOT include manifest.json in its own files map
  // (see archive.rs: manifest_bytes is written separately before iterating
  // the archive_files BTreeMap). So manifest.json is the one allowed
  // unlisted entry; every other regular file must appear in manifest.files.
  const manifestKeys = new Set(Object.keys(manifest.files));
  for (const archivePath of files.keys()) {
    if (archivePath === RUNNER_MANIFEST_PATH) continue;
    if (!manifestKeys.has(archivePath)) {
      manifest_errors.push({
        code: "FILE_NOT_IN_MANIFEST",
        message: `Archive contains ${archivePath} but the manifest does not list it`,
        path: archivePath,
      });
    }
  }

  // Step 5: parse the two artifacts honest-health depends on, if present.
  // Failures here do NOT make the manifest invalid; they leave
  // observation_health / correlation_report undefined and the H2 gate then
  // reports the missing payload.
  let observation_health: RunnerObservationHealth | undefined;
  const obsBytes = files.get(RUNNER_OBSERVATION_HEALTH_PATH);
  if (obsBytes) {
    const parsed = safeJsonParse<RunnerObservationHealth>(obsBytes);
    if (parsed && parsed.schema === RUNNER_OBSERVATION_HEALTH_SCHEMA) {
      observation_health = parsed;
    } else if (parsed) {
      artifact_parse_errors.push({
        code: "OBSERVATION_HEALTH_SCHEMA_MISMATCH",
        message: `Expected schema ${RUNNER_OBSERVATION_HEALTH_SCHEMA}; got ${
          typeof parsed.schema === "string"
            ? JSON.stringify(parsed.schema)
            : "(missing)"
        }`,
        path: RUNNER_OBSERVATION_HEALTH_PATH,
      });
    } else {
      artifact_parse_errors.push({
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
      artifact_parse_errors.push({
        code: "CORRELATION_REPORT_SCHEMA_MISMATCH",
        message: `Expected schema ${RUNNER_CORRELATION_REPORT_SCHEMA}; got ${
          typeof parsed.schema === "string"
            ? JSON.stringify(parsed.schema)
            : "(missing)"
        }`,
        path: RUNNER_CORRELATION_REPORT_PATH,
      });
    } else {
      artifact_parse_errors.push({
        code: "CORRELATION_REPORT_NOT_JSON",
        message: `${RUNNER_CORRELATION_REPORT_PATH} is not valid JSON`,
        path: RUNNER_CORRELATION_REPORT_PATH,
      });
    }
  }

  return {
    recognised: true,
    manifest_valid: manifest_errors.length === 0,
    manifest_errors,
    artifact_parse_errors,
    manifest,
    observation_health,
    correlation_report,
  };
}

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
  const stat = statSync(filePath);
  if (stat.size > RUNNER_ARCHIVE_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `compressed archive size ${stat.size} bytes exceeds limit ${RUNNER_ARCHIVE_MAX_COMPRESSED_BYTES} bytes (ARCHIVE_TOO_LARGE)`,
    );
  }
  const compressed = readFileSync(filePath);
  // Node's gunzipSync accepts `maxOutputLength` as a hard cap. If the
  // decompressed stream exceeds the cap, gunzipSync throws synchronously
  // before allocating beyond the limit. This protects against zip-bomb-style
  // archives that gzip to a small size but expand catastrophically.
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(compressed, {
      maxOutputLength: RUNNER_ARCHIVE_MAX_DECOMPRESSED_BYTES,
    });
  } catch (err) {
    throw new Error(
      `gunzip failed (possibly DECOMPRESSED_TOO_LARGE; limit ${RUNNER_ARCHIVE_MAX_DECOMPRESSED_BYTES} bytes): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
