import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  COMMITTED_CARRIER_PATH,
  COMMITTED_PROVENANCE_PATH,
  ENFORCEMENT_HEALTH_CARRIER,
  PINNED_RELEASE_ASSET_DIGEST,
  verifyEnforcementHealthPromotion,
} from "../dist/enforcement_health_promotion.js";
import { productionDeps, readCommittedTree } from "../dist/enforcement_health_promotion_cli.js";
import { buildEnforcementHealthProvenance } from "../dist/enforcement_health_record.js";

const ROOT = mkdtempSync(join(tmpdir(), "eh-promo-cli-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const RUN_ID = "33080000001";
const BINARY_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIXTURE_DIGEST = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const CARRIER_BYTES = Buffer.from('{"schema":"assay.enforcement_health.v1","status":"active"}\n');
const ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(CARRIER_BYTES).digest("hex")}`;

function git(repo, args, extra = {}) {
  const child = spawnSync("git", ["-C", repo, "-c", "user.email=ci@example.com", "-c", "user.name=ci", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    ...extra,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout || args.join(" "));
  return child.stdout.trim();
}

function writeRepoFile(repo, rel, bytes) {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function provenanceBytes() {
  const prov = buildEnforcementHealthProvenance({
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
  });
  return Buffer.from(`${JSON.stringify(prov, null, 2)}\n`);
}

function seedRepo() {
  const repo = mkdtempSync(join(ROOT, "repo-"));
  git(repo, ["init"]);
  writeRepoFile(repo, ".github/workflows/harness-ci.yml", Buffer.from("name: Harness CI\n"));
  writeRepoFile(repo, "harness/scripts/probe-v54-enforcement-health.mjs", Buffer.from("export {}\n"));
  writeRepoFile(repo, COMMITTED_CARRIER_PATH, CARRIER_BYTES);
  writeRepoFile(repo, COMMITTED_PROVENANCE_PATH, provenanceBytes());
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "run tree"]);
  const runHead = git(repo, ["rev-parse", "HEAD"]);
  return { repo, runHead };
}

function commitEdit(repo, rel, bytes, message) {
  writeRepoFile(repo, rel, bytes);
  git(repo, ["add", rel]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function row(hostedRun) {
  return {
    carrier: ENFORCEMENT_HEALTH_CARRIER,
    proof: {
      hosted_run: hostedRun,
      artifact_digest: ARTIFACT_DIGEST,
      assay_binary_digest: BINARY_DIGEST,
      fixture_digest: FIXTURE_DIGEST,
      assay_version: "v5.4.0",
    },
  };
}

function githubOverlay(runHead, files) {
  return {
    getRun: async () => ({
      id: Number(RUN_ID),
      path: ".github/workflows/harness-ci.yml",
      name: "Harness CI",
      head_sha: runHead,
      status: "completed",
      conclusion: "success",
    }),
    getJobs: async () => [{ name: "Assay Enforcement Health Probe", conclusion: "success", status: "completed" }],
    getArtifactFiles: async () => files,
  };
}

function productionGitDeps(repo, promotingHead, runHead, files) {
  const deps = productionDeps(repo, "unused-token", promotingHead);
  Object.assign(deps, githubOverlay(runHead, files));
  return deps;
}

test("production deps fail-closed when a committed measurement-surface path is edited after the run", async () => {
  const { repo, runHead } = seedRepo();
  const promotingHead = commitEdit(
    repo,
    "harness/scripts/probe-v54-enforcement-health.mjs",
    Buffer.from("export const edited = true;\n"),
    "post-run probe edit",
  );
  const files = {
    "enforcement-health.json": CARRIER_BYTES,
    "recipe.provenance.json": provenanceBytes(),
  };
  const verdict = await verifyEnforcementHealthPromotion({
    baseRow: row(null),
    headRow: row(RUN_ID),
    promotingHead,
    deps: productionGitDeps(repo, promotingHead, runHead, files),
  });
  assert.equal(verdict.status, "failed", JSON.stringify(verdict));
  assert.equal(verdict.code, "measurement_surface_changed", JSON.stringify(verdict));
});

async function promoteWith(repo, promotingHead, runHead, files, depOverrides = {}) {
  return verifyEnforcementHealthPromotion({
    baseRow: row(null),
    headRow: row(RUN_ID),
    promotingHead,
    deps: { ...productionGitDeps(repo, promotingHead, runHead, files), ...depOverrides },
  });
}

test("production readCommitted fail-closes a post-run committed provenance edit while downloaded artifacts stay put", async () => {
  const { repo, runHead } = seedRepo();
  const originalProv = provenanceBytes();
  const mutatedProv = Buffer.from(originalProv.toString("utf8").replace('"hosted": true', '"hosted": true '));
  assert.notEqual(Buffer.compare(originalProv, mutatedProv), 0);
  const promotingHead = commitEdit(repo, COMMITTED_PROVENANCE_PATH, mutatedProv, "post-run provenance edit");
  const files = {
    "enforcement-health.json": CARRIER_BYTES,
    "recipe.provenance.json": originalProv,
  };
  const verdict = await promoteWith(repo, promotingHead, runHead, files);
  assert.equal(verdict.status, "failed", JSON.stringify(verdict));
  assert.equal(verdict.code, "artifact_changed", JSON.stringify(verdict));
});

test("production matching control: committed tree equals downloaded artifacts", async () => {
  const { repo, runHead } = seedRepo();
  const files = {
    "enforcement-health.json": CARRIER_BYTES,
    "recipe.provenance.json": provenanceBytes(),
  };
  const verdict = await promoteWith(repo, runHead, runHead, files);
  assert.equal(verdict.status, "passed", JSON.stringify(verdict));
});

test("mutation: production readCommitted removed is observed", async () => {
  const { repo, runHead } = seedRepo();
  const originalProv = provenanceBytes();
  const mutatedProv = Buffer.from(originalProv.toString("utf8").replace('"hosted": true', '"hosted": true '));
  const promotingHead = commitEdit(repo, COMMITTED_PROVENANCE_PATH, mutatedProv, "post-run provenance edit");
  const files = {
    "enforcement-health.json": CARRIER_BYTES,
    "recipe.provenance.json": originalProv,
  };
  const deps = productionGitDeps(repo, promotingHead, runHead, files);
  assert.equal(typeof deps.readCommitted, "function");
  delete deps.readCommitted;
  const verdict = await verifyEnforcementHealthPromotion({
    baseRow: row(null),
    headRow: row(RUN_ID),
    promotingHead,
    deps,
  });
  assert.equal(verdict.status, "passed", "removing the production hook must turn the provenance-edit case green");
});

test("mutation: wrong repo, ref, or path fail-closed", async () => {
  const { repo, runHead } = seedRepo();
  const files = {
    "enforcement-health.json": CARRIER_BYTES,
    "recipe.provenance.json": provenanceBytes(),
  };
  const missingRepo = mkdtempSync(join(ROOT, "missing-"));
  const wrongRepo = await promoteWith(missingRepo, runHead, runHead, files);
  assert.equal(wrongRepo.status, "failed", JSON.stringify(wrongRepo));
  assert.equal(wrongRepo.code, "api_failure", JSON.stringify(wrongRepo));

  const wrongRef = await promoteWith(repo, "ffffffffffffffffffffffffffffffffffffffff", runHead, files);
  assert.equal(wrongRef.status, "failed", JSON.stringify(wrongRef));
  assert.equal(wrongRef.code, "api_failure", JSON.stringify(wrongRef));

  assert.throws(() => readCommittedTree(repo, `${runHead}:not/a/real/path`), /committed (carrier|provenance) read failed/);
});

test("mutation: working-tree bytes are not accepted as the committed copy", async () => {
  const { repo, runHead } = seedRepo();
  const originalProv = provenanceBytes();
  writeRepoFile(repo, COMMITTED_PROVENANCE_PATH, Buffer.from(originalProv.toString("utf8").replace('"hosted": true', '"hosted": true ')));
  const files = {
    "enforcement-health.json": CARRIER_BYTES,
    "recipe.provenance.json": originalProv,
  };
  const committed = readCommittedTree(repo, runHead);
  assert.equal(Buffer.compare(committed.provenance, originalProv), 0);
  const verdict = await promoteWith(repo, runHead, runHead, files);
  assert.equal(verdict.status, "passed", JSON.stringify(verdict));
});

test("mutation: readCommitted error is not silently accepted", async () => {
  const { repo, runHead } = seedRepo();
  const files = {
    "enforcement-health.json": CARRIER_BYTES,
    "recipe.provenance.json": provenanceBytes(),
  };
  const thrown = await promoteWith(repo, runHead, runHead, files, {
    readCommitted: async () => {
      throw new Error("ECONNRESET");
    },
  });
  assert.equal(thrown.status, "failed", JSON.stringify(thrown));
  assert.equal(thrown.code, "api_failure", JSON.stringify(thrown));

  const nulled = await promoteWith(repo, runHead, runHead, files, {
    readCommitted: async () => null,
  });
  assert.equal(nulled.status, "failed", JSON.stringify(nulled));
  assert.equal(nulled.code, "api_failure", JSON.stringify(nulled));
});
