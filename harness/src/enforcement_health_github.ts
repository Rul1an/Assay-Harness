export const ALLOWED_GITHUB_API_ORIGIN = "https://api.github.com";
export const ALLOWED_REPO = "Rul1an/Assay-Harness";

const RUN_PATH = /^\/repos\/Rul1an\/Assay-Harness\/actions\/runs\/[1-9][0-9]*$/;
const JOBS_PATH = /^\/repos\/Rul1an\/Assay-Harness\/actions\/runs\/[1-9][0-9]*\/jobs$/;
const ARTIFACTS_PATH = /^\/repos\/Rul1an\/Assay-Harness\/actions\/runs\/[1-9][0-9]*\/artifacts$/;
const ARTIFACT_ZIP_PATH = /^\/repos\/Rul1an\/Assay-Harness\/actions\/artifacts\/[1-9][0-9]*\/zip$/;

export type GithubApiTarget =
  | { kind: "run"; runId: string }
  | { kind: "jobs"; runId: string }
  | { kind: "artifacts"; runId: string }
  | { kind: "artifactZip"; artifactId: number };

export type FetchImpl = (input: URL, init?: RequestInit) => Promise<Response>;

export function requireAllowedRepo(ownerRepo: string): string {
  if (ownerRepo !== ALLOWED_REPO) {
    throw new Error("repository is not the allowlisted Assay-Harness repo");
  }
  return ownerRepo;
}

export function requirePositiveDecimalRunId(runId: string): string {
  if (!/^[1-9][0-9]*$/.test(runId) || !Number.isSafeInteger(Number(runId))) {
    throw new Error("run id must be a positive decimal safe integer");
  }
  return runId;
}

export function requireSafePositiveArtifactId(id: unknown): number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new Error("artifact id must be a positive safe integer");
  }
  return id;
}

export function assertAllowlistedGithubUrl(url: URL): void {
  if (url.origin !== ALLOWED_GITHUB_API_ORIGIN) {
    throw new Error("refusing non-allowlisted GitHub API origin");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("refusing GitHub API URL with userinfo or hash");
  }
  const pathOk =
    RUN_PATH.test(url.pathname) ||
    JOBS_PATH.test(url.pathname) ||
    ARTIFACTS_PATH.test(url.pathname) ||
    ARTIFACT_ZIP_PATH.test(url.pathname);
  if (!pathOk) {
    throw new Error("refusing GitHub API pathname outside the allowlisted repo actions paths");
  }
  const jobsOrArtifacts = JOBS_PATH.test(url.pathname) || ARTIFACTS_PATH.test(url.pathname);
  if (jobsOrArtifacts && url.search !== "?per_page=100") {
    throw new Error("refusing unexpected GitHub API query");
  }
  if (!jobsOrArtifacts && url.search !== "") {
    throw new Error("refusing unexpected GitHub API query");
  }
}

export function buildGithubApiUrl(target: GithubApiTarget): URL {
  const url = new URL(ALLOWED_GITHUB_API_ORIGIN);
  switch (target.kind) {
    case "run": {
      const runId = requirePositiveDecimalRunId(target.runId);
      url.pathname = `/repos/${ALLOWED_REPO}/actions/runs/${runId}`;
      break;
    }
    case "jobs": {
      const runId = requirePositiveDecimalRunId(target.runId);
      url.pathname = `/repos/${ALLOWED_REPO}/actions/runs/${runId}/jobs`;
      url.searchParams.set("per_page", "100");
      break;
    }
    case "artifacts": {
      const runId = requirePositiveDecimalRunId(target.runId);
      url.pathname = `/repos/${ALLOWED_REPO}/actions/runs/${runId}/artifacts`;
      url.searchParams.set("per_page", "100");
      break;
    }
    case "artifactZip": {
      const artifactId = requireSafePositiveArtifactId(target.artifactId);
      url.pathname = `/repos/${ALLOWED_REPO}/actions/artifacts/${artifactId}/zip`;
      break;
    }
    default: {
      const _never: never = target;
      throw new Error(`unexpected GitHub API target: ${JSON.stringify(_never)}`);
    }
  }
  assertAllowlistedGithubUrl(url);
  return url;
}

export async function githubFetch(url: URL, token: string, fetchImpl: FetchImpl = fetch): Promise<Response> {
  assertAllowlistedGithubUrl(url);
  if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
    throw new Error("refusing fetch to non-allowlisted GitHub API host");
  }
  return fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}
