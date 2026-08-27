import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ENFORCEMENT_HEALTH_CARRIER,
  PINNED_RELEASE_ASSET_DIGEST,
  verifyEnforcementHealthPromotion,
} from "../dist/enforcement_health_promotion.js";
import { buildEnforcementHealthProvenance } from "../dist/enforcement_health_record.js";

const RUN_ID = "33080000001";
const RUN_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROMOTE_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIBLING = "cccccccccccccccccccccccccccccccccccccccc";
const BINARY_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIXTURE_DIGEST = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const CARRIER_BYTES = Buffer.from('{"schema":"assay.enforcement_health.v1","status":"active"}\n');
const ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(CARRIER_BYTES).digest("hex")}`;
const WRONG_DIGEST = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function row(hostedRun, extras = {}) {
  return {
    carrier: ENFORCEMENT_HEALTH_CARRIER,
    proof: {
      hosted_run: hostedRun,
      artifact_digest: ARTIFACT_DIGEST,
      assay_binary_digest: BINARY_DIGEST,
      fixture_digest: FIXTURE_DIGEST,
      assay_version: "v5.4.0",
      ...extras,
    },
  };
}

function provenance(overrides = {}) {
  return buildEnforcementHealthProvenance({
    hostedRun: RUN_ID,
    runnerOs: "ubuntu-latest",
    assayVersion: "v5.4.0",
    binaryDigest: BINARY_DIGEST,
    releaseAssetPath: "assay-v5.4.0-x86_64-unknown-linux-gnu.tar.gz",
    releaseAssetDigest: PINNED_RELEASE_ASSET_DIGEST,
    fixturePath: "fixtures/suite-compatibility/enforcement-health/probe-policy.yaml",
    fixtureDigest: FIXTURE_DIGEST,
    artifactPath: "carriers/assay.enforcement_health.v1.json",
    artifactDigest: ARTIFACT_DIGEST,
    harnessVersion: "0.10.2",
    ...overrides,
  });
}

function filesFrom(prov, carrier = CARRIER_BYTES) {
  return {
    "enforcement-health.json": carrier,
    "recipe.provenance.json": Buffer.from(`${JSON.stringify(prov, null, 2)}\n`),
  };
}

function depsFrom(overrides = {}) {
  const files = filesFrom(provenance());
  return {
    getRun: async () => ({
      id: Number(RUN_ID),
      path: ".github/workflows/harness-ci.yml",
      name: "Harness CI",
      head_sha: RUN_HEAD,
      status: "completed",
      conclusion: "success",
    }),
    getJobs: async () => [{ name: "Assay Enforcement Health Probe", conclusion: "success", status: "completed" }],
    getArtifactFiles: async () => files,
    isAncestor: async (ancestor, descendant) => ancestor === RUN_HEAD && descendant === PROMOTE_HEAD,
    changedPaths: async () => ["harness/suite-compatibility.json"],
    readCommitted: async () => ({
      carrier: CARRIER_BYTES,
      provenance: files["recipe.provenance.json"],
    }),
    ...overrides,
  };
}

async function promote(depOverrides = {}, headExtras = {}) {
  return verifyEnforcementHealthPromotion({
    baseRow: row(null),
    headRow: row(RUN_ID, headExtras),
    promotingHead: PROMOTE_HEAD,
    deps: depsFrom(depOverrides),
  });
}

async function mustFail(label, expectedCode, depOverrides, headExtras) {
  const verdict = await promote(depOverrides, headExtras);
  assert.equal(verdict.status, "failed", `${label}: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.code, expectedCode, `${label}: ${JSON.stringify(verdict)}`);
}

test("mutation: wrong workflow fails closed", async () => {
  await mustFail("wrong workflow", "wrong_workflow", {
    getRun: async () => ({
      id: Number(RUN_ID),
      path: ".github/workflows/other.yml",
      name: "Other",
      head_sha: RUN_HEAD,
      status: "completed",
      conclusion: "success",
    }),
  });
});

test("mutation: skipped job fails closed", async () => {
  await mustFail("skipped job", "job_not_success", {
    getJobs: async () => [{ name: "Assay Enforcement Health Probe", conclusion: "skipped", status: "completed" }],
  });
});

test("mutation: cancelled job fails closed", async () => {
  await mustFail("cancelled job", "job_not_success", {
    getJobs: async () => [{ name: "Assay Enforcement Health Probe", conclusion: "cancelled", status: "completed" }],
  });
});

test("mutation: failed job fails closed", async () => {
  await mustFail("failed job", "job_not_success", {
    getJobs: async () => [{ name: "Assay Enforcement Health Probe", conclusion: "failure", status: "completed" }],
  });
});

test("mutation: sibling or non-ancestor run head fails closed", async () => {
  await mustFail("sibling", "non_ancestor", {
    isAncestor: async () => false,
    getRun: async () => ({
      id: Number(RUN_ID),
      path: ".github/workflows/harness-ci.yml",
      name: "Harness CI",
      head_sha: SIBLING,
      status: "completed",
      conclusion: "success",
    }),
  });
});

test("mutation: post-run probe edit fails closed", async () => {
  await mustFail("probe edit", "measurement_surface_changed", {
    changedPaths: async () => ["harness/scripts/probe-v54-enforcement-health.mjs"],
  });
});

test("mutation: post-run workflow edit fails closed", async () => {
  await mustFail("workflow edit", "measurement_surface_changed", {
    changedPaths: async () => [".github/workflows/harness-ci.yml"],
  });
});

test("mutation: wrong row digest fails closed", async () => {
  await mustFail("wrong row digest", "digest_mismatch", {}, { artifact_digest: WRONG_DIGEST });
});

test("mutation: changed artifact fails closed", async () => {
  const changed = Buffer.from('{"schema":"assay.enforcement_health.v1","status":"failed"}\n');
  await mustFail("changed artifact", "artifact_changed", {
    getArtifactFiles: async () => filesFrom(provenance(), changed),
  });
});

test("mutation: missing artifact fails closed", async () => {
  await mustFail("missing artifact", "artifact_missing", {
    getArtifactFiles: async () => ({}),
  });
});

test("mutation: deleted ancestor check is observed on the production path", async () => {
  let ancestorCalls = 0;
  const verdict = await verifyEnforcementHealthPromotion({
    baseRow: row(null),
    headRow: row(RUN_ID),
    promotingHead: PROMOTE_HEAD,
    deps: depsFrom({
      isAncestor: async () => {
        ancestorCalls += 1;
        return true;
      },
    }),
  });
  assert.equal(verdict.status, "passed", JSON.stringify(verdict));
  assert.ok(ancestorCalls >= 1, "deleting the ancestor check must turn this RED");
});

test("mutation: API 404/rate-limit/network failure fails closed", async () => {
  for (const [label, getRun] of [
    ["404", async () => ({ error: { status: 404, message: "Not Found" } })],
    ["429", async () => ({ error: { status: 429, message: "rate limit" } })],
    ["network", async () => {
      throw new Error("ECONNRESET");
    }],
  ]) {
    const verdict = await promote({ getRun });
    assert.equal(verdict.status, "failed", `${label}: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.code, "api_failure", `${label}: ${JSON.stringify(verdict)}`);
  }
});

test("mutation table: 14 fail-closed bites, no-op and valid controls live in the sibling file", () => {
  assert.equal(WRONG_DIGEST !== ARTIFACT_DIGEST, true);
  assert.equal(PINNED_RELEASE_ASSET_DIGEST !== BINARY_DIGEST, true);
});
