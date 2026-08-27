import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "./cli_exit.js";
import { materializePromotionArtifacts, productionZipIo } from "./enforcement_health_artifact.js";
import {
  buildGithubApiUrl,
  githubFetch,
  requireAllowedRepo,
  requireSafePositiveArtifactId,
} from "./enforcement_health_github.js";
import {
  COMMITTED_CARRIER_PATH,
  COMMITTED_PROVENANCE_PATH,
  findEnforcementHealthRow,
  type ApiErrorResult,
  type GithubJob,
  type GithubRun,
  type PromotionDeps,
  type PromotionVerdict,
  verifyEnforcementHealthPromotion,
} from "./enforcement_health_promotion.js";

function argValue(argv: string[], name: string): string {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (!value || value.startsWith("--")) {
    console.error(`[config_error] --${name} is required`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  return value;
}

function readMatrix(path: string): { carrier_rows?: Array<{ carrier?: string; proof?: Record<string, unknown> }> } {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      carrier_rows?: Array<{ carrier?: string; proof?: Record<string, unknown> }>;
    };
  } catch (error) {
    console.error(`[artifact_contract] cannot read matrix ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
}

function apiError(status: number, message: string): ApiErrorResult {
  return { error: { status, message } };
}

function gitText(repoRoot: string, args: string[]): { ok: true; stdout: string } | { ok: false; message: string; status: number } {
  const child = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (child.status === 0) return { ok: true, stdout: child.stdout };
  return { ok: false, message: child.stderr || child.stdout || "git failed", status: child.status ?? 128 };
}

function gitBytes(repoRoot: string, args: string[]): { ok: true; stdout: Buffer } | { ok: false; message: string; status: number } {
  const child = spawnSync("git", ["-C", repoRoot, ...args]);
  const stdout = Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(child.stdout ?? "");
  const stderr = Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.from(child.stderr ?? "");
  if (child.status === 0) return { ok: true, stdout };
  return { ok: false, message: stderr.toString("utf8") || stdout.toString("utf8") || "git failed", status: child.status ?? 128 };
}

export function readCommittedTree(repoRoot: string, ref: string): { carrier: Buffer; provenance: Buffer } {
  const carrier = gitBytes(repoRoot, ["show", `${ref}:${COMMITTED_CARRIER_PATH}`]);
  if (!carrier.ok) throw new Error(`committed carrier read failed: ${carrier.message}`);
  const provenance = gitBytes(repoRoot, ["show", `${ref}:${COMMITTED_PROVENANCE_PATH}`]);
  if (!provenance.ok) throw new Error(`committed provenance read failed: ${provenance.message}`);
  return { carrier: carrier.stdout, provenance: provenance.stdout };
}

async function githubJson(url: URL, token: string): Promise<unknown | ApiErrorResult> {
  try {
    const response = await githubFetch(url, token);
    if (!response.ok) return apiError(response.status, await response.text());
    return response.json();
  } catch (error) {
    return apiError(500, error instanceof Error ? error.message : String(error));
  }
}

export function productionDeps(repoRoot: string, token: string, promotingHead: string): PromotionDeps {
  return {
    async getRun(runId) {
      const data = await githubJson(buildGithubApiUrl({ kind: "run", runId }), token);
      if (data && typeof data === "object" && "error" in data) return data as ApiErrorResult;
      const run = data as GithubRun;
      if (!run?.path || !run.head_sha) return apiError(500, "run payload missing path or head_sha");
      return run;
    },
    async getJobs(runId) {
      const data = await githubJson(buildGithubApiUrl({ kind: "jobs", runId }), token);
      if (data && typeof data === "object" && "error" in data) return data as ApiErrorResult;
      const jobs = (data as { jobs?: GithubJob[] }).jobs;
      if (!Array.isArray(jobs)) return apiError(500, "jobs payload missing jobs[]");
      return jobs;
    },
    async getArtifactFiles(runId) {
      const listed = await githubJson(buildGithubApiUrl({ kind: "artifacts", runId }), token);
      if (listed && typeof listed === "object" && "error" in listed) return listed as ApiErrorResult;
      const artifacts = (listed as { artifacts?: Array<{ id: number; name: string }> }).artifacts ?? [];
      const artifact = artifacts.find((item) => item.name === "enforcement-health-carrier");
      if (!artifact) return {};
      let artifactId: number;
      try {
        artifactId = requireSafePositiveArtifactId(artifact.id);
      } catch (error) {
        return apiError(500, error instanceof Error ? error.message : String(error));
      }
      try {
        const response = await githubFetch(buildGithubApiUrl({ kind: "artifactZip", artifactId }), token);
        if (!response.ok) return apiError(response.status, await response.text());
        const dir = mkdtempSync(join(tmpdir(), "eh-artifact-"));
        try {
          return await materializePromotionArtifacts({
            response,
            dest: join(dir, "artifact.zip"),
            io: productionZipIo(),
          });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch (error) {
        return apiError(500, error instanceof Error ? error.message : String(error));
      }
    },
    async isAncestor(ancestorSha, descendantSha) {
      const result = gitText(repoRoot, ["merge-base", "--is-ancestor", ancestorSha, descendantSha]);
      if (result.ok) return true;
      if (result.status === 1) return false;
      throw new Error(`ancestor check failed: ${result.message}`);
    },
    async changedPaths(fromSha, toSha) {
      const result = gitText(repoRoot, ["diff", "--name-only", fromSha, toSha]);
      if (!result.ok) throw new Error(`diff failed: ${result.message}`);
      return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    },
    async readCommitted() {
      return readCommittedTree(repoRoot, promotingHead);
    },
  };
}

function exitFor(verdict: PromotionVerdict): number {
  switch (verdict.status) {
    case "passed":
    case "skipped":
      return EXIT.SUCCESS;
    case "failed":
      return EXIT.ARTIFACT_CONTRACT;
    default: {
      const _never: never = verdict;
      throw new Error(`unexpected verdict: ${JSON.stringify(_never)}`);
    }
  }
}

function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (invokedAsMain()) {
  const argv = process.argv.slice(2);
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const repo = process.env.GH_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.error("[config_error] GH_TOKEN and GH_REPOSITORY are required");
    process.exit(EXIT.CONFIG_ERROR);
  }
  try {
    requireAllowedRepo(repo);
  } catch (error) {
    console.error(`[config_error] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  const promotingHead = argValue(argv, "promoting-head");
  const verdict = await verifyEnforcementHealthPromotion({
    baseRow: findEnforcementHealthRow(readMatrix(argValue(argv, "base-matrix"))),
    headRow: findEnforcementHealthRow(readMatrix(argValue(argv, "head-matrix"))),
    promotingHead,
    deps: productionDeps(argValue(argv, "repo-root"), token, promotingHead),
  });

  if (verdict.status === "skipped") {
    process.stdout.write(`enforcement-health promotion skipped: ${verdict.reason}\n`);
  } else if (verdict.status === "passed") {
    process.stdout.write("enforcement-health promotion passed\n");
  } else if (verdict.status === "failed") {
    console.error(`[artifact_contract] ${verdict.code}: ${verdict.message}`);
  } else {
    const _never: never = verdict;
    throw new Error(`unexpected verdict: ${JSON.stringify(_never)}`);
  }
  process.exit(exitFor(verdict));
}
