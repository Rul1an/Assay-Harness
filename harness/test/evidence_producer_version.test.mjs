// Guard against producer-version drift in the harness's evidence emitter.
//
// Audit at commit c2c869c found that PRODUCER_VERSION in src/evidence.ts was
// hardcoded to "0.1.0" while the package was at "0.3.2". Every evidence event
// stamped the wrong version, breaking traceability.
//
// The fix sources the version from package.json directly. This test makes the
// fix non-negotiable: any future divergence between the emitted version and
// the package.json fails CI.
//
// Mirrors test style of cyclonedx_mlbom_model_receipt_pipeline_recipe.test.mjs

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { PRODUCER_VERSION } from "../dist/evidence.js";

// Resolve harness/ from this test file's URL. fileURLToPath + dirname
// works on every supported Node version (matches the convention in
// trust_basis_*.test.mjs and avoids the Node 20.11+-only
// `import.meta.dirname` shortcut).
const harnessRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("evidence PRODUCER_VERSION matches package.json version", () => {
  const pkg = JSON.parse(readFileSync(join(harnessRoot, "package.json"), "utf8"));
  assert.equal(
    PRODUCER_VERSION,
    pkg.version,
    `PRODUCER_VERSION (${PRODUCER_VERSION}) drifted from package.json version (${pkg.version})`,
  );
});

test("evidence PRODUCER_VERSION is a non-empty semver-like string", () => {
  assert.ok(typeof PRODUCER_VERSION === "string", "PRODUCER_VERSION must be a string");
  assert.ok(PRODUCER_VERSION.length > 0, "PRODUCER_VERSION must not be empty");
  // semver.org grammar: <major>.<minor>.<patch>[-pre][+build]
  // Both pre-release and build-metadata identifiers are dot-separated
  // sequences of [0-9A-Za-z-].
  assert.match(
    PRODUCER_VERSION,
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    `PRODUCER_VERSION must look like a semver (including optional build metadata), got: ${PRODUCER_VERSION}`,
  );
});

test("evidence PRODUCER_VERSION is not the placeholder literal '0.1.0' once package leaves 0.1.0", () => {
  // If package.json says 0.1.0, that is allowed (pre-release). Otherwise the
  // emitted version must follow. This catches "I bumped package but evidence
  // still emits 0.1.0" regressions specifically.
  const pkg = JSON.parse(readFileSync(join(harnessRoot, "package.json"), "utf8"));
  if (pkg.version !== "0.1.0") {
    assert.notEqual(
      PRODUCER_VERSION,
      "0.1.0",
      `Package is at ${pkg.version} but evidence still emits 0.1.0 — the audit-flagged regression`,
    );
  }
});
