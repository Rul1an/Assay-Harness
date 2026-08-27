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
const BINARY_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIXTURE_DIGEST = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const CARRIER_BYTES = Buffer.from('{"schema":"assay.enforcement_health.v1","status":"active"}\n');
const ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(CARRIER_BYTES).digest("hex")}`;

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

function trackingDeps(overrides = {}) {
  const calls = { ancestor: 0, api: 0 };
  const files = filesFrom(provenance());
  const deps = {
    getRun: async () => {
      calls.api += 1;
      return {
        id: Number(RUN_ID),
        path: ".github/workflows/harness-ci.yml",
        name: "Harness CI",
        head_sha: RUN_HEAD,
        status: "completed",
        conclusion: "success",
      };
    },
    getJobs: async () => {
      calls.api += 1;
      return [{ name: "Assay Enforcement Health Probe", conclusion: "success", status: "completed" }];
    },
    getArtifactFiles: async () => {
      calls.api += 1;
      return files;
    },
    isAncestor: async (ancestor, descendant) => {
      calls.ancestor += 1;
      return ancestor === RUN_HEAD && descendant === PROMOTE_HEAD;
    },
    changedPaths: async () => ["harness/suite-compatibility.json", "docs/ASSAY_COMPATIBILITY.md"],
    readCommitted: async () => ({
      carrier: CARRIER_BYTES,
      provenance: files["recipe.provenance.json"],
    }),
    ...overrides,
  };
  return { deps, calls, files };
}

test("record helper keeps release-asset and extracted-binary digests distinct", () => {
  const prov = provenance();
  assert.equal(prov.schema, "suite.recipe_provenance.v0");
  assert.equal(prov.release_asset.digest, PINNED_RELEASE_ASSET_DIGEST);
  assert.equal(prov.assay.binary_digest, BINARY_DIGEST);
  assert.notEqual(prov.release_asset.digest, prov.assay.binary_digest);
  assert.throws(
    () => provenance({ binaryDigest: PINNED_RELEASE_ASSET_DIGEST }),
    /distinct|release-asset|binary/i,
  );
});

test("no-op control: unchanged hosted_run skips without calling GitHub", async () => {
  const { deps, calls } = trackingDeps({
    getRun: async () => {
      throw new Error("API must not be called on skip");
    },
  });
  const verdict = await verifyEnforcementHealthPromotion({
    baseRow: row(null),
    headRow: row(null),
    promotingHead: PROMOTE_HEAD,
    deps,
  });
  assert.equal(verdict.status, "skipped");
  assert.equal(verdict.reason, "hosted_run_unchanged");
  assert.equal(calls.api, 0);
  assert.equal(calls.ancestor, 0);
});

test("valid control: ancestor run, unchanged measurement surface, matching artifacts", async () => {
  const { deps, calls } = trackingDeps();
  const verdict = await verifyEnforcementHealthPromotion({
    baseRow: row(null),
    headRow: row(RUN_ID),
    promotingHead: PROMOTE_HEAD,
    deps,
  });
  assert.equal(verdict.status, "passed", JSON.stringify(verdict));
  assert.ok(calls.ancestor >= 1, "ancestor check must be invoked on the production path");
  assert.ok(calls.api >= 1);
});
