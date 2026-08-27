import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ALLOWED_GITHUB_API_ORIGIN,
  assertAllowlistedGithubUrl,
  buildGithubApiUrl,
  githubFetch,
  requireAllowedRepo,
  requirePositiveDecimalRunId,
  requireSafePositiveArtifactId,
} from "../dist/enforcement_health_github.js";

const SRC = fileURLToPath(new URL("../src/enforcement_health_github.ts", import.meta.url));

function source() {
  return readFileSync(SRC, "utf8");
}

test("mutation: deleting the repo allowlist would accept a foreign repo", () => {
  assert.throws(() => requireAllowedRepo("evil/repo"), /allowlist|repository/i);
  assert.throws(() => requireAllowedRepo("Rul1an/assay-harness"), /allowlist|repository/i);
  assert.match(source(), /ownerRepo !== ALLOWED_REPO|ALLOWED_REPO/);
  assert.match(source(), /Rul1an\/Assay-Harness/);
});

test("mutation: deleting the run-id allowlist would accept path injection", () => {
  for (const runId of ["0", "-1", "01", "1e2", "12.3", "abc", "../3308", "3308/../1", "3308%2e%2e", ""]) {
    assert.throws(() => requirePositiveDecimalRunId(runId), /run id/i, runId);
    assert.throws(() => buildGithubApiUrl({ kind: "run", runId }), /run id/i, runId);
  }
});

test("mutation: deleting the artifact-id allowlist would accept a non-safe id", () => {
  for (const artifactId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => requireSafePositiveArtifactId(artifactId), /artifact id/i, String(artifactId));
    if (Number.isSafeInteger(artifactId)) {
      assert.throws(() => buildGithubApiUrl({ kind: "artifactZip", artifactId }), /artifact id/i);
    }
  }
});

test("mutation: deleting the origin allowlist would fetch a foreign host", async () => {
  const evil = new URL("https://evil.example/repos/Rul1an/Assay-Harness/actions/runs/1");
  assert.throws(() => assertAllowlistedGithubUrl(evil), /origin|allowlist|host/i);
  let fetched = 0;
  await assert.rejects(
    () => githubFetch(evil, "token", async () => {
      fetched += 1;
      return new Response("no");
    }),
    /origin|allowlist|host/i,
  );
  assert.equal(fetched, 0);
});

test("mutation: deleting the pathname allowlist would fetch a foreign repo path", () => {
  const foreign = new URL("https://api.github.com/repos/evil/x/actions/runs/1");
  assert.equal(foreign.origin, ALLOWED_GITHUB_API_ORIGIN);
  assert.throws(() => assertAllowlistedGithubUrl(foreign), /path|allowlist|repo/i);
  const scheme = new URL("http://api.github.com/repos/Rul1an/Assay-Harness/actions/runs/1");
  assert.throws(() => assertAllowlistedGithubUrl(scheme), /origin|https|allowlist|host/i);
});

test("mutation: buildGithubApiUrl ignores an attacker-supplied url field", () => {
  const url = buildGithubApiUrl({ kind: "run", runId: "9", url: "https://evil.example/steal" });
  assert.equal(url.origin, ALLOWED_GITHUB_API_ORIGIN);
  assert.doesNotMatch(url.href, /evil/);
});
