import { RECIPE_PROVENANCE_SCHEMA, type RecipeProvenance } from "./suite_recipe_provenance.js";

export const ENFORCEMENT_HEALTH_CARRIER = "assay.enforcement_health.v1";
export const PINNED_ASSAY_VERSION = "v5.4.0";
export const PINNED_RELEASE_ASSET_DIGEST =
  "sha256:352cd390dc59fb5adacecae5adf51976419f18ae50918f8f1504952869e94ad3";
export const POLICY_FIXTURE_PATH = "fixtures/suite-compatibility/enforcement-health/probe-policy.yaml";
export const PROBE_RECIPE = "assay_enforcement_health_e2e";
export const SHA256_HEX = /^sha256:[0-9a-f]{64}$/;

const PRODUCER_ARGV =
  "sandbox --enforce --enforce-net --probe-enforcement --enforcement-health /tmp/enforcement-health.json --policy fixtures/suite-compatibility/enforcement-health/probe-policy.yaml -- true";

export interface EnforcementHealthRecordInput {
  hostedRun: string;
  runnerOs: string;
  assayVersion: string;
  binaryDigest: string;
  releaseAssetPath: string;
  releaseAssetDigest: string;
  fixturePath: string;
  fixtureDigest: string;
  artifactPath: string;
  artifactDigest: string;
  harnessVersion: string;
}

function requireSha256(label: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  }
}

export function buildEnforcementHealthProvenance(input: EnforcementHealthRecordInput): RecipeProvenance {
  requireSha256("release-asset digest", input.releaseAssetDigest);
  requireSha256("extracted-binary digest", input.binaryDigest);
  requireSha256("fixture digest", input.fixtureDigest);
  requireSha256("artifact digest", input.artifactDigest);
  if (input.releaseAssetDigest === input.binaryDigest) {
    throw new Error("release-asset and extracted-binary digests must be distinct");
  }
  if (input.releaseAssetDigest !== PINNED_RELEASE_ASSET_DIGEST) {
    throw new Error("release-asset digest is not the pinned v5.4.0 x86_64 digest");
  }
  return {
    schema: RECIPE_PROVENANCE_SCHEMA,
    recipe: PROBE_RECIPE,
    hosted_run: input.hostedRun,
    runner_os: input.runnerOs,
    hosted: true,
    ambient_scan: false,
    assay: {
      version: input.assayVersion,
      binary_digest: input.binaryDigest,
      command: `assay ${PRODUCER_ARGV}`,
    },
    release_asset: { path: input.releaseAssetPath, digest: input.releaseAssetDigest },
    fixture: { path: input.fixturePath, digest: input.fixtureDigest },
    artifact: { path: input.artifactPath, digest: input.artifactDigest },
    harness: {
      version: input.harnessVersion,
      command: "assay-harness carrier enforcement-health --carrier carriers/assay.enforcement_health.v1.json",
    },
    result: { exit_code: 0, classification: "success" },
  };
}
