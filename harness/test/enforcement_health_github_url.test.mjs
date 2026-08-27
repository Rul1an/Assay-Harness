import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ALLOWED_GITHUB_API_ORIGIN,
  ALLOWED_REPO,
  assertAllowlistedGithubUrl,
  buildGithubApiUrl,
  githubFetch,
  requireAllowedRepo,
  requirePositiveDecimalRunId,
  requireSafePositiveArtifactId,
} from "../dist/enforcement_health_github.js";

test("allowlisted repo and constructed URLs stay on https://api.github.com", () => {
  assert.equal(ALLOWED_REPO, "Rul1an/Assay-Harness");
  assert.equal(ALLOWED_GITHUB_API_ORIGIN, "https://api.github.com");
  assert.equal(requireAllowedRepo("Rul1an/Assay-Harness"), "Rul1an/Assay-Harness");
  const run = buildGithubApiUrl({ kind: "run", runId: "33080000001" });
  assert.equal(run.origin, ALLOWED_GITHUB_API_ORIGIN);
  assert.equal(run.pathname, "/repos/Rul1an/Assay-Harness/actions/runs/33080000001");
  assert.equal(run.search, "");
  const jobs = buildGithubApiUrl({ kind: "jobs", runId: "33080000001" });
  assert.equal(jobs.searchParams.get("per_page"), "100");
  const zip = buildGithubApiUrl({ kind: "artifactZip", artifactId: 99 });
  assert.equal(zip.pathname, "/repos/Rul1an/Assay-Harness/actions/artifacts/99/zip");
});

test("githubFetch only receives allowlisted URL objects and never a raw URL string", async () => {
  const seen = [];
  const url = buildGithubApiUrl({ kind: "run", runId: "1" });
  const response = await githubFetch(url, "token", async (input) => {
    seen.push(input);
    return new Response("{}", { status: 200 });
  });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof URL);
  assert.equal(seen[0].origin, ALLOWED_GITHUB_API_ORIGIN);
});
