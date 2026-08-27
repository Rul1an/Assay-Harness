import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "./cli_exit.js";
import {
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
    return JSON.parse(readFileSync(path, "utf8")) as { carrier_rows?: Array<{ carrier?: string; proof?: Record<string, unknown> }> };
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

async function githubJson(url: string, token: string): Promise<unknown | ApiErrorResult> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    return apiError(response.status, await response.text());
  }
  return response.json();
}

function productionDeps(repoRoot: string, ownerRepo: string, token: string): PromotionDeps {
  const api = `https://api.github.com/repos/${ownerRepo}`;
  return {
    async getRun(runId) {
      const data = await githubJson(`${api}/actions/runs/${runId}`, token);
      if (data && typeof data === "object" && "error" in data) return data as ApiErrorResult;
      const run = data as GithubRun;
      if (!run?.path || !run.head_sha) return apiError(500, "run payload missing path or head_sha");
      return run;
    },
    async getJobs(runId) {
      const data = await githubJson(`${api}/actions/runs/${runId}/jobs?per_page=100`, token);
      if (data && typeof data === "object" && "error" in data) return data as ApiErrorResult;
      const jobs = (data as { jobs?: GithubJob[] }).jobs;
      if (!Array.isArray(jobs)) return apiError(500, "jobs payload missing jobs[]");
      return jobs;
    },
    async getArtifactFiles(runId) {
      const listed = await githubJson(`${api}/actions/runs/${runId}/artifacts?per_page=100`, token);
      if (listed && typeof listed === "object" && "error" in listed) return listed as ApiErrorResult;
      const artifacts = (listed as { artifacts?: Array<{ id: number; name: string }> }).artifacts ?? [];
      const artifact = artifacts.find((item) => item.name === "enforcement-health-carrier");
      if (!artifact) return {};
      const response = await fetch(`${api}/actions/artifacts/${artifact.id}/zip`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (!response.ok) return apiError(response.status, await response.text());
      const zip = Buffer.from(await response.arrayBuffer());
      const dir = mkdtempSync(join(tmpdir(), "eh-artifact-"));
      try {
        const zipPath = join(dir, "artifact.zip");
        writeFileSync(zipPath, zip);
        const unzip = spawnSync("unzip", ["-o", zipPath, "-d", dir], { encoding: "utf8" });
        if (unzip.status !== 0) return apiError(500, unzip.stderr || "unzip failed");
        const files: Record<string, Buffer> = {};
        const walk = (root: string, prefix = ""): void => {
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const full = join(root, entry.name);
            if (entry.isDirectory()) walk(full, rel);
            else if (entry.isFile()) files[rel] = readFileSync(full);
          }
        };
        walk(dir);
        delete files["artifact.zip"];
        return files;
      } finally {
        rmSync(dir, { recursive: true, force: true });
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

const argv = process.argv.slice(2);
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const repo = process.env.GH_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
  console.error("[config_error] GH_TOKEN and GH_REPOSITORY are required");
  process.exit(EXIT.CONFIG_ERROR);
}

const verdict = await verifyEnforcementHealthPromotion({
  baseRow: findEnforcementHealthRow(readMatrix(argValue(argv, "base-matrix"))),
  headRow: findEnforcementHealthRow(readMatrix(argValue(argv, "head-matrix"))),
  promotingHead: argValue(argv, "promoting-head"),
  deps: productionDeps(argValue(argv, "repo-root"), repo, token),
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
