/**
 * Real Assay-Runner archive smoke test.
 *
 * Closes Rul1an/Assay-Harness#65. Validates one .tar.gz produced
 * upstream by `assay runner-spike` (committed in `Rul1an/assay`
 * PR #1377, run 26442807783) so that contract drift between the
 * Runner emission side and the Harness parser surfaces as a CI
 * failure rather than hiding behind synthetic-only coverage.
 *
 * Scope is deliberately narrow:
 *
 * - Tier-1 only: validateRunnerArchive + checkHonestHealth.
 * - Not a measurement test. The kernel capture happened upstream;
 *   here we read a static byte snapshot.
 * - Not a Tier-2 diff or Tier-3 cross-runtime test; those use
 *   different fixtures.
 *
 * See `harness/fixtures/runner/PROVENANCE.md` for the source commit
 * and refresh policy.
 */

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  checkHonestHealth,
  RUNNER_ARCHIVE_MANIFEST_SCHEMA,
  RUNNER_CAPABILITY_SURFACE_SCHEMA,
  RUNNER_CORRELATION_REPORT_SCHEMA,
  RUNNER_OBSERVATION_HEALTH_SCHEMA,
  validateRunnerArchive,
} from "../dist/runner_archive.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "fixtures",
  "runner",
  "slice3-arm-c-kernel-event-v0.tar.gz",
);

test("real Runner archive: Tier-1 validation passes", () => {
  const result = validateRunnerArchive(FIXTURE_PATH);

  assert.equal(
    result.recognised,
    true,
    "fixture should be recognised as a Runner archive",
  );
  assert.equal(
    result.manifest_valid,
    true,
    `manifest validation failed: ${JSON.stringify(result.manifest_errors)}`,
  );
  assert.deepEqual(
    result.manifest_errors,
    [],
    "no manifest_errors expected from a clean upstream archive",
  );
});

test("real Runner archive: schema strings match the v0 contract", () => {
  const result = validateRunnerArchive(FIXTURE_PATH);

  assert.equal(result.manifest?.schema, RUNNER_ARCHIVE_MANIFEST_SCHEMA);
  assert.equal(
    result.capability_surface?.schema,
    RUNNER_CAPABILITY_SURFACE_SCHEMA,
  );
  assert.equal(
    result.observation_health?.schema,
    RUNNER_OBSERVATION_HEALTH_SCHEMA,
  );
  assert.equal(
    result.correlation_report?.schema,
    RUNNER_CORRELATION_REPORT_SCHEMA,
  );
});

test("real Runner archive: manifest digests use the sha256:<hex> shape", () => {
  const result = validateRunnerArchive(FIXTURE_PATH);

  assert.ok(result.manifest, "manifest object expected");
  const files = result.manifest.files ?? {};
  const entries = Object.entries(files);
  assert.ok(entries.length > 0, "manifest should list archive files");

  for (const [path, entry] of entries) {
    assert.match(
      entry.sha256,
      /^sha256:[0-9a-f]{64}$/,
      `manifest.files[${JSON.stringify(path)}].sha256 must be 'sha256:<64-hex>'`,
    );
  }
});

test("real Runner archive: honest-health gate passes", () => {
  const validation = validateRunnerArchive(FIXTURE_PATH);
  const verdict = checkHonestHealth(validation);

  assert.equal(
    verdict.passed,
    true,
    `honest-health gate failed unexpectedly: ${JSON.stringify(verdict.reasons)}`,
  );
  assert.deepEqual(verdict.structural_reasons, []);
  assert.deepEqual(verdict.measurement_health_reasons, []);
});
