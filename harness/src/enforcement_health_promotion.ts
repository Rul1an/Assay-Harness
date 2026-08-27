import { createHash } from "node:crypto";
import {
  ENFORCEMENT_HEALTH_CARRIER,
  PINNED_RELEASE_ASSET_DIGEST,
} from "./enforcement_health_record.js";

export {
  ENFORCEMENT_HEALTH_CARRIER,
  PINNED_ASSAY_VERSION,
  PINNED_RELEASE_ASSET_DIGEST,
} from "./enforcement_health_record.js";

export const WORKFLOW_PATH = ".github/workflows/harness-ci.yml";
export const PROBE_JOB_NAME = "Assay Enforcement Health Probe";
export const MEASUREMENT_SURFACE_PATHS = [
  ".github/workflows/harness-ci.yml",
  "harness/scripts/probe-v54-enforcement-health.mjs",
] as const;
export const CARRIER_FILE = "enforcement-health.json";
export const PROVENANCE_FILE = "recipe.provenance.json";

export type PromotionFailureCode =
  | "wrong_workflow"
  | "job_not_success"
  | "non_ancestor"
  | "measurement_surface_changed"
  | "digest_mismatch"
  | "artifact_missing"
  | "artifact_changed"
  | "api_failure";

export type PromotionVerdict =
  | { status: "skipped"; reason: "hosted_run_unchanged" }
  | { status: "passed" }
  | { status: "failed"; code: PromotionFailureCode; message: string };

export type ApiErrorResult = { error: { status: number; message: string } };

export interface GithubRun {
  id: number;
  path: string;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

export interface GithubJob {
  name: string;
  conclusion: string | null;
  status: string;
}

export interface PromotionRow {
  carrier?: string;
  proof?: {
    hosted_run?: string | null;
    artifact_digest?: string | null;
    assay_binary_digest?: string | null;
    fixture_digest?: string | null;
    assay_version?: string | null;
  };
}

export interface PromotionDeps {
  getRun: (runId: string) => Promise<GithubRun | ApiErrorResult>;
  getJobs: (runId: string) => Promise<GithubJob[] | ApiErrorResult>;
  getArtifactFiles: (runId: string) => Promise<Record<string, Buffer> | ApiErrorResult>;
  isAncestor: (ancestorSha: string, descendantSha: string) => Promise<boolean>;
  changedPaths: (fromSha: string, toSha: string) => Promise<string[]>;
  readCommitted?: () => Promise<{ carrier: Buffer; provenance: Buffer } | null>;
}

function hostedRunOf(row: PromotionRow | null | undefined): string | null {
  const value = row?.proof?.hosted_run;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function failed(code: PromotionFailureCode, message: string): PromotionVerdict {
  return { status: "failed", code, message };
}

function isApiError(value: unknown): value is ApiErrorResult {
  return typeof value === "object" && value !== null && "error" in value && Boolean((value as ApiErrorResult).error);
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pickFile(files: Record<string, Buffer>, name: string): Buffer | undefined {
  if (files[name]) return files[name];
  const hit = Object.entries(files).find(([key]) => key === name || key.endsWith(`/${name}`));
  return hit?.[1];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function verifyEnforcementHealthPromotion(input: {
  baseRow: PromotionRow | null;
  headRow: PromotionRow | null;
  promotingHead: string;
  deps: PromotionDeps;
}): Promise<PromotionVerdict> {
  const baseRun = hostedRunOf(input.baseRow);
  const headRun = hostedRunOf(input.headRow);
  if (baseRun === headRun) {
    return { status: "skipped", reason: "hosted_run_unchanged" };
  }
  if (!headRun) {
    return failed("digest_mismatch", "hosted_run changed but the promoting row has no run id");
  }
  try {
    return await verifyChangedRun(headRun, input.headRow, input.promotingHead, input.deps);
  } catch (error) {
    return failed("api_failure", error instanceof Error ? error.message : String(error));
  }
}

async function verifyChangedRun(
  runId: string,
  headRow: PromotionRow | null,
  promotingHead: string,
  deps: PromotionDeps,
): Promise<PromotionVerdict> {
  const runOrErr = await deps.getRun(runId);
  if (isApiError(runOrErr)) return failed("api_failure", `${runOrErr.error.status} ${runOrErr.error.message}`);
  if (runOrErr.path !== WORKFLOW_PATH) {
    return failed("wrong_workflow", `run ${runId} is ${runOrErr.path}, not ${WORKFLOW_PATH}`);
  }
  if (runOrErr.conclusion !== "success") {
    return failed("job_not_success", `run conclusion is ${runOrErr.conclusion ?? runOrErr.status}`);
  }

  const jobsOrErr = await deps.getJobs(runId);
  if (isApiError(jobsOrErr)) return failed("api_failure", `${jobsOrErr.error.status} ${jobsOrErr.error.message}`);
  const probeJob = jobsOrErr.find((job) => job.name === PROBE_JOB_NAME);
  if (!probeJob || probeJob.conclusion !== "success") {
    return failed("job_not_success", `job ${PROBE_JOB_NAME} conclusion is ${probeJob?.conclusion ?? "missing"}`);
  }

  const ancestor = await deps.isAncestor(runOrErr.head_sha, promotingHead);
  if (!ancestor) {
    return failed("non_ancestor", `run head ${runOrErr.head_sha} is not an ancestor of ${promotingHead}`);
  }

  const changed = await deps.changedPaths(runOrErr.head_sha, promotingHead);
  const surfaceHit = MEASUREMENT_SURFACE_PATHS.find((path) => changed.includes(path));
  if (surfaceHit) {
    return failed("measurement_surface_changed", `measurement surface changed after the run: ${surfaceHit}`);
  }

  const filesOrErr = await deps.getArtifactFiles(runId);
  if (isApiError(filesOrErr)) return failed("api_failure", `${filesOrErr.error.status} ${filesOrErr.error.message}`);
  const carrier = pickFile(filesOrErr, CARRIER_FILE);
  const provenanceBytes = pickFile(filesOrErr, PROVENANCE_FILE);
  if (!carrier || !provenanceBytes) {
    return failed("artifact_missing", "run is missing enforcement-health.json or recipe.provenance.json");
  }

  if (deps.readCommitted) {
    const committed = await deps.readCommitted();
    if (committed && (!committed.carrier.equals(carrier) || !committed.provenance.equals(provenanceBytes))) {
      return failed("artifact_changed", "downloaded artifacts do not match the committed carrier or provenance");
    }
  }

  const proof = headRow?.proof ?? {};
  const carrierDigest = sha256(carrier);
  if (proof.artifact_digest !== carrierDigest) {
    return failed("digest_mismatch", "row artifact_digest does not match the uploaded carrier");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(provenanceBytes.toString("utf8"));
  } catch {
    return failed("digest_mismatch", "uploaded provenance is not JSON");
  }
  const provenance = asObject(parsed);
  const assay = asObject(provenance?.assay);
  const fixture = asObject(provenance?.fixture);
  const artifact = asObject(provenance?.artifact);
  const releaseAsset = asObject(provenance?.release_asset);
  if (
    provenance?.hosted_run !== runId ||
    assay?.binary_digest !== proof.assay_binary_digest ||
    fixture?.digest !== proof.fixture_digest ||
    artifact?.digest !== proof.artifact_digest ||
    releaseAsset?.digest !== PINNED_RELEASE_ASSET_DIGEST ||
    releaseAsset?.digest === assay?.binary_digest
  ) {
    return failed("digest_mismatch", "uploaded provenance does not match the promoting row or pinned asset digest");
  }
  return { status: "passed" };
}

export function findEnforcementHealthRow(matrix: { carrier_rows?: PromotionRow[] } | null): PromotionRow | null {
  return matrix?.carrier_rows?.find((row) => row.carrier === ENFORCEMENT_HEALTH_CARRIER) ?? null;
}
