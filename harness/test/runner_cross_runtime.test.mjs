import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCrossRuntimeReport,
  formatCrossRuntimeReport,
  RUNNER_CROSS_RUNTIME_DIFF_SCHEMA,
  RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER,
  RUNNER_CROSS_RUNTIME_REQUIRED_NON_CLAIMS,
  RUNNER_CROSS_RUNTIME_REQUIRED_NOTES,
  RUNNER_CROSS_RUNTIME_SDK_METADATA_MARKER,
  validateCrossRuntimeDiff,
} from "../dist/runner_cross_runtime.js";

// ---------------------------------------------------------------------------
// Fixture builder — clean cross-runtime diff payload
// ---------------------------------------------------------------------------

function emptyCategory() {
  return { added: [], removed: [], unchanged: [] };
}

function buildCleanDiff(overrides = {}) {
  const base = {
    schema: RUNNER_CROSS_RUNTIME_DIFF_SCHEMA,
    base_run_id: "run_openai_agents_kernel_policy_determinism",
    head_run_id: "run_gemini_google_genai_kernel_policy_determinism",
    base_runtime: "s5_openai_agents",
    head_runtime: "gemini_google_genai",
    status: "clean",
    preconditions: {
      base_health_clean: true,
      head_health_clean: true,
      base_correlation_clean: true,
      head_correlation_clean: true,
      stable_tool_call_ids_required: true,
      stable_tool_call_ids_present: true,
      runtimes_distinct: true,
    },
    scope: {
      projection: "surface_set",
      uses_raw_telemetry: false,
      uses_proof_pack: false,
      per_binding_capability_values: false,
      cross_runtime: true,
    },
    canonicalization: {
      filesystem_paths: "work_dir_prefix_only",
      network_endpoints: "none",
      process_execs: "none",
      mcp_tools: "none",
      policy_decisions: "none",
    },
    surface: {
      filesystem_paths: emptyCategory(),
      network_endpoints: emptyCategory(),
      process_execs: emptyCategory(),
      mcp_tools: emptyCategory(),
      policy_decisions: emptyCategory(),
    },
    binding_ids: { comparison: RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER },
    policy_outcomes: { comparison: RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER },
    sdk_metadata: {
      comparison: RUNNER_CROSS_RUNTIME_SDK_METADATA_MARKER,
      base: { sdk_name: "@openai/agents", sdk_version: "0.11.4" },
      head: { sdk_name: "google-genai", sdk_version: "2.6.0" },
    },
    unbound: {
      filesystem_paths: [],
      network_endpoints: [],
      process_execs: [],
      mcp_tools: [],
      policy_decisions: [],
    },
    non_claims: [...RUNNER_CROSS_RUNTIME_REQUIRED_NON_CLAIMS],
    ambiguities: [],
    notes: [...RUNNER_CROSS_RUNTIME_REQUIRED_NOTES],
  };
  return { ...base, ...overrides };
}

function writeDiff(dir, name, payload) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// validateCrossRuntimeDiff (Tier 3A shape contract)
// ---------------------------------------------------------------------------

test("validateCrossRuntimeDiff accepts a clean v0 payload", () => {
  const v = validateCrossRuntimeDiff(buildCleanDiff());
  assert.equal(v.valid, true);
  assert.deepEqual(v.errors, []);
  assert.equal(v.diff.schema, RUNNER_CROSS_RUNTIME_DIFF_SCHEMA);
});

test("validateCrossRuntimeDiff rejects wrong schema string", () => {
  const v = validateCrossRuntimeDiff({
    ...buildCleanDiff(),
    schema: "some.other.schema.v0",
  });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CROSS_RUNTIME_SCHEMA_MISMATCH");
});

test("validateCrossRuntimeDiff rejects non-object payload", () => {
  const v = validateCrossRuntimeDiff("not an object");
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CROSS_RUNTIME_NOT_OBJECT");
});

test("validateCrossRuntimeDiff rejects missing surface category", () => {
  const diff = buildCleanDiff();
  delete diff.surface.filesystem_paths;
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_CATEGORY_SHAPE_INVALID"));
});

test("validateCrossRuntimeDiff rejects non-array added field", () => {
  const diff = buildCleanDiff();
  diff.surface.network_endpoints.added = "oops";
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_CATEGORY_SHAPE_INVALID"));
});

test("validateCrossRuntimeDiff rejects tampered binding_ids marker", () => {
  const diff = buildCleanDiff();
  diff.binding_ids.comparison = "comparable_by_tool_call_id";
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(
      (e) => e.code === "CROSS_RUNTIME_BINDING_IDS_MARKER_INVALID",
    ),
  );
});

test("validateCrossRuntimeDiff rejects tampered policy_outcomes marker", () => {
  const diff = buildCleanDiff();
  diff.policy_outcomes.comparison = "set_diff";
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(
      (e) => e.code === "CROSS_RUNTIME_POLICY_OUTCOMES_MARKER_INVALID",
    ),
  );
});

test("validateCrossRuntimeDiff rejects sdk_metadata not marked side_band", () => {
  const diff = buildCleanDiff();
  diff.sdk_metadata.comparison = "capability_relevant";
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(
      (e) => e.code === "CROSS_RUNTIME_SDK_METADATA_MARKER_INVALID",
    ),
  );
});

test("validateCrossRuntimeDiff rejects missing sdk_metadata side", () => {
  const diff = buildCleanDiff();
  delete diff.sdk_metadata.head;
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some((e) => e.code === "CROSS_RUNTIME_SDK_METADATA_SIDE_INVALID"),
  );
});

// ---------------------------------------------------------------------------
// buildCrossRuntimeReport behaviour
// ---------------------------------------------------------------------------

test("buildCrossRuntimeReport: clean diff → has_added_capability=false, sdk_changed=true", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-clean-"));
  const path = writeDiff(dir, "clean.json", buildCleanDiff());
  const report = buildCrossRuntimeReport(path);
  assert.equal(report.validation.valid, true);
  assert.equal(report.has_added_capability, false);
  assert.equal(report.sdk_metadata_changed, true); // openai vs google-genai
  assert.deepEqual(report.added_counts, {
    filesystem_paths: 0,
    network_endpoints: 0,
    process_execs: 0,
    mcp_tools: 0,
    policy_decisions: 0,
  });
});

test("buildCrossRuntimeReport: added filesystem_path triggers has_added_capability", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-added-"));
  const diff = buildCleanDiff();
  diff.surface.filesystem_paths.added = ["<work>/gemini-input.txt"];
  const path = writeDiff(dir, "added.json", diff);
  const report = buildCrossRuntimeReport(path);
  assert.equal(report.has_added_capability, true);
  assert.equal(report.added_counts.filesystem_paths, 1);
  // Tier 3A report still validates as a structurally valid diff.
  assert.equal(report.validation.valid, true);
});

test("buildCrossRuntimeReport: invalid JSON → validation error, no parsed diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-badjson-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "this { is not json");
  const report = buildCrossRuntimeReport(path);
  assert.equal(report.validation.valid, false);
  assert.equal(report.validation.errors[0].code, "CROSS_RUNTIME_NOT_JSON");
  assert.equal(report.validation.diff, undefined);
});

test("buildCrossRuntimeReport: sdk_metadata identical on both sides → not changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-samesdk-"));
  const diff = buildCleanDiff();
  diff.sdk_metadata.base = { sdk_name: "same-sdk", sdk_version: "1.0.0" };
  diff.sdk_metadata.head = { sdk_name: "same-sdk", sdk_version: "1.0.0" };
  const path = writeDiff(dir, "samesdk.json", diff);
  const report = buildCrossRuntimeReport(path);
  assert.equal(report.sdk_metadata_changed, false);
});

// ---------------------------------------------------------------------------
// formatCrossRuntimeReport markdown discipline
// ---------------------------------------------------------------------------

test("markdown formatter: clean diff → OK status, no regression block", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-fmt-ok-"));
  const path = writeDiff(dir, "clean.json", buildCleanDiff());
  const md = formatCrossRuntimeReport(buildCrossRuntimeReport(path));
  assert.match(md, /\*\*Status:\*\* OK/);
  assert.doesNotMatch(md, /## Regression Summary/);
});

test("markdown formatter: added capability → REGRESSION status + Regression Summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-fmt-reg-"));
  const diff = buildCleanDiff();
  diff.surface.filesystem_paths.added = ["<work>/x"];
  diff.surface.mcp_tools.added = ["write_file"];
  const path = writeDiff(dir, "reg.json", diff);
  const md = formatCrossRuntimeReport(buildCrossRuntimeReport(path));
  assert.match(md, /\*\*Status:\*\* RUNNER CROSS-RUNTIME REGRESSION/);
  assert.match(md, /## Regression Summary/);
  assert.match(md, /filesystem_paths_added:1/);
  assert.match(md, /mcp_tools_added:1/);
});

test("markdown formatter: invalid diff → TIER-3A INVALID DIFF status", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-fmt-bad-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "garbage");
  const md = formatCrossRuntimeReport(buildCrossRuntimeReport(path));
  assert.match(md, /\*\*Status:\*\* TIER-3A INVALID DIFF/);
  assert.match(md, /## Diff Validation Errors/);
});

test("markdown formatter: sdk metadata change → side-band section, never regression", () => {
  // SDK metadata differs (default fixture) but no surface added entries.
  // The status must stay OK; the SDK section must appear with the caveat.
  const dir = mkdtempSync(join(tmpdir(), "xrt-fmt-sdk-"));
  const path = writeDiff(dir, "sdk.json", buildCleanDiff());
  const md = formatCrossRuntimeReport(buildCrossRuntimeReport(path));
  assert.match(md, /\*\*Status:\*\* OK/);
  assert.match(md, /## SDK Metadata \(side-band only\)/);
  // Spans a blockquote line break, so just confirm both phrases appear.
  assert.match(md, /NEVER/);
  assert.match(md, /treated as a capability regression/);
});

test("markdown formatter: removed entries reported but never as regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-fmt-removed-"));
  const diff = buildCleanDiff();
  diff.surface.filesystem_paths.removed = ["<work>/old"];
  const path = writeDiff(dir, "removed.json", diff);
  const md = formatCrossRuntimeReport(buildCrossRuntimeReport(path));
  assert.match(md, /\*\*Status:\*\* OK/);
  assert.match(md, /Removed \(not blocking in v0\)/);
});

test("markdown formatter omits unchanged lists (refinement D parity)", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-fmt-unchanged-"));
  const diff = buildCleanDiff();
  diff.surface.filesystem_paths.unchanged = ["<work>/keep"];
  const path = writeDiff(dir, "u.json", diff);
  const md = formatCrossRuntimeReport(buildCrossRuntimeReport(path));
  // No "Unchanged:" sub-heading in markdown (the value still appears in JSON).
  assert.doesNotMatch(md, /\bUnchanged:/);
});

// ---------------------------------------------------------------------------
// CLI exit code routing (Tier 3A `report` verb)
// ---------------------------------------------------------------------------

import { join as pathJoin } from "node:path";
const CLI_DIST = pathJoin(
  new URL(".", import.meta.url).pathname,
  "..",
  "dist",
  "cli.js",
);

function runCli(args) {
  return spawnSync(process.execPath, [CLI_DIST, ...args], { encoding: "utf8" });
}

test("CLI: runner cross-runtime report on clean diff → exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-cli-ok-"));
  const path = writeDiff(dir, "clean.json", buildCleanDiff());
  const out = runCli(["runner", "cross-runtime", "report", "--diff", path]);
  assert.equal(out.status, 0, `expected 0, got ${out.status}; stderr=${out.stderr}`);
});

test("CLI: runner cross-runtime report on added-capability diff → exit 0 (report is informational)", () => {
  // Tier 3A `report` does NOT exit 6 even when the diff contains added
  // capability surface. Exit 6 is reserved for the future `gate` verb.
  const dir = mkdtempSync(join(tmpdir(), "xrt-cli-added-"));
  const diff = buildCleanDiff();
  diff.surface.filesystem_paths.added = ["<work>/new"];
  const path = writeDiff(dir, "added.json", diff);
  const out = runCli(["runner", "cross-runtime", "report", "--diff", path]);
  assert.equal(out.status, 0, `expected 0 for report verb, got ${out.status}; stderr=${out.stderr}`);
  assert.match(out.stdout, /RUNNER CROSS-RUNTIME REGRESSION/);
});

test("CLI: runner cross-runtime report on invalid JSON → exit 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-cli-bad-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "not json");
  const out = runCli(["runner", "cross-runtime", "report", "--diff", path]);
  assert.equal(out.status, 3, `expected 3 for invalid diff, got ${out.status}; stderr=${out.stderr}`);
});

test("CLI: runner cross-runtime report on tampered binding_ids marker → exit 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-cli-tampered-"));
  const diff = buildCleanDiff();
  diff.binding_ids.comparison = "comparable";
  const path = writeDiff(dir, "tampered.json", diff);
  const out = runCli(["runner", "cross-runtime", "report", "--diff", path]);
  assert.equal(out.status, 3, `expected 3 for tampered marker, got ${out.status}; stderr=${out.stderr}`);
});

test("CLI: runner cross-runtime report missing --diff → exit 2", () => {
  const out = runCli(["runner", "cross-runtime", "report"]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--diff/);
});

test("CLI: runner cross-runtime report --diff <not-a-file> → exit 2 (config_error)", () => {
  const out = runCli([
    "runner",
    "cross-runtime",
    "report",
    "--diff",
    "/nonexistent/path/diff.json",
  ]);
  assert.equal(out.status, 2);
});

test("CLI: unknown runner cross-runtime subcommand → exit 2 with usage", () => {
  // `gate` is now a real subcommand (Tier 3C). Use a still-unknown one.
  // Tier 3B (archive-pair convenience wrapper) remains deferred and is
  // mentioned in the usage hint, but is not a CLI verb.
  const out = runCli(["runner", "cross-runtime", "summarise"]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Tier 3B.*not implemented/);
});

// ---------------------------------------------------------------------------
// PR #64 review regression coverage — strict clean-schema invariants
// ---------------------------------------------------------------------------

test("P1 — bare `--diff` flag (no value) exits 2 cleanly, does not crash", () => {
  // parseArgs maps `--diff` without a value to `true`; the CLI must
  // refuse this with config_error rather than passing `true` into
  // existsSync / readFileSync.
  const out = runCli(["runner", "cross-runtime", "report", "--diff"]);
  assert.equal(out.status, 2, `expected exit 2 for bare --diff, got ${out.status}; stderr=${out.stderr}`);
  assert.match(out.stderr, /--diff.*required.*non-empty/);
});

test("P1 — status: 'failed' is rejected (only clean v0 supported)", () => {
  const diff = buildCleanDiff();
  diff.status = "failed";
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_STATUS_NOT_CLEAN"));
});

test("P1 — same-runtime diff is rejected", () => {
  const diff = buildCleanDiff();
  diff.head_runtime = "s5_openai_agents"; // same as base
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_RUNTIMES_NOT_DISTINCT"));
});

test("P1 — unknown runtime identifier is rejected", () => {
  const diff = buildCleanDiff();
  diff.head_runtime = "future_runtime_x";
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_RUNTIME_UNKNOWN"));
});

test("P1 — preconditions with any false key is rejected", () => {
  const diff = buildCleanDiff();
  diff.preconditions.runtimes_distinct = false;
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_PRECONDITION_NOT_TRUE"));
});

test("P1 — preconditions with missing key is rejected", () => {
  const diff = buildCleanDiff();
  delete diff.preconditions.base_health_clean;
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_PRECONDITION_NOT_TRUE"));
});

test("P1 — scope.uses_raw_telemetry=true is rejected", () => {
  const diff = buildCleanDiff();
  diff.scope.uses_raw_telemetry = true;
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_SCOPE_VALUE_INVALID"));
});

test("P1 — scope.projection != surface_set is rejected", () => {
  const diff = buildCleanDiff();
  diff.scope.projection = "raw_event_stream";
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_SCOPE_VALUE_INVALID"));
});

test("P1 — canonicalization.filesystem_paths != work_dir_prefix_only is rejected (A1 invariant)", () => {
  const diff = buildCleanDiff();
  diff.canonicalization.filesystem_paths = "filename_role_equivalence";
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_CANONICALIZATION_INVALID"));
});

test("P1 — non-empty unbound is rejected for clean diff", () => {
  const diff = buildCleanDiff();
  diff.unbound.filesystem_paths = ["unresolved-path"];
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_UNBOUND_NOT_EMPTY"));
});

test("P1 — non-empty ambiguities is rejected for clean diff", () => {
  const diff = buildCleanDiff();
  diff.ambiguities = ["one_unresolved_binding"];
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_AMBIGUITIES_NOT_EMPTY"));
});

test("P2 — non_claims missing a required code is rejected", () => {
  const diff = buildCleanDiff();
  diff.non_claims = diff.non_claims.slice(0, 4); // drop the last one
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_NON_CLAIMS_INVALID"));
});

test("P2 — non_claims with extra arbitrary code is rejected", () => {
  const diff = buildCleanDiff();
  diff.non_claims = [...diff.non_claims, "some_arbitrary_extra_code"];
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_NON_CLAIMS_INVALID"));
});

test("P2 — non_claims in wrong order is rejected", () => {
  const diff = buildCleanDiff();
  diff.non_claims = [
    "cross_runtime_no_sdk_capability_equivalence",
    "cross_runtime_no_filename_semantic_equivalence",
    "cross_runtime_no_derived_binding_identity",
    "cross_runtime_no_declared_capability_input",
    "cross_runtime_no_acceptability_judgment",
  ];
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_NON_CLAIMS_INVALID"));
});

test("P2 — notes other than the 3 required strings rejected", () => {
  const diff = buildCleanDiff();
  diff.notes = ["test_fixture"];
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_NOTES_INVALID"));
});

test("P2 — empty notes array rejected (must be exactly 3 strings)", () => {
  const diff = buildCleanDiff();
  diff.notes = [];
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_NOTES_INVALID"));
});

test("category arrays with duplicate entries are rejected (uniqueItems invariant)", () => {
  const diff = buildCleanDiff();
  diff.surface.filesystem_paths.added = ["<work>/a", "<work>/a"];
  const v = validateCrossRuntimeDiff(diff);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CROSS_RUNTIME_CATEGORY_DUPLICATES"));
});

// ---------------------------------------------------------------------------
// Tier 3C — `runner cross-runtime gate` CLI exit routing
// ---------------------------------------------------------------------------

test("Tier 3C gate: clean diff (no added capability) → exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-gate-clean-"));
  const path = writeDiff(dir, "clean.json", buildCleanDiff());
  const out = runCli(["runner", "cross-runtime", "gate", "--diff", path]);
  assert.equal(out.status, 0, `expected 0, got ${out.status}; stderr=${out.stderr}`);
  assert.match(out.stderr, /\[success\].*no added capability surface/);
});

test("Tier 3C gate: added filesystem_path → exit 6 (regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-gate-fs-"));
  const diff = buildCleanDiff();
  diff.surface.filesystem_paths.added = ["<work>/new"];
  const path = writeDiff(dir, "added.json", diff);
  const out = runCli(["runner", "cross-runtime", "gate", "--diff", path]);
  assert.equal(out.status, 6, `expected 6, got ${out.status}; stderr=${out.stderr}`);
  assert.match(out.stderr, /\[regression\].*filesystem_paths=1/);
});

test("Tier 3C gate: added network_endpoint → exit 6", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-gate-net-"));
  const diff = buildCleanDiff();
  diff.surface.network_endpoints.added = ["api.example.com:443"];
  const path = writeDiff(dir, "net.json", diff);
  const out = runCli(["runner", "cross-runtime", "gate", "--diff", path]);
  assert.equal(out.status, 6, `expected 6, got ${out.status}; stderr=${out.stderr}`);
});

test("Tier 3C gate: only removed entries → exit 0 (removed is not blocking in v0)", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-gate-removed-"));
  const diff = buildCleanDiff();
  diff.surface.filesystem_paths.removed = ["<work>/old"];
  const path = writeDiff(dir, "removed.json", diff);
  const out = runCli(["runner", "cross-runtime", "gate", "--diff", path]);
  assert.equal(out.status, 0, `expected 0, got ${out.status}; stderr=${out.stderr}`);
});

test("Tier 3C gate: SDK metadata change only → exit 0 (side-band, never regression)", () => {
  // Default fixture already has differing sdk_name/sdk_version between base
  // and head. Without any added capability surface, the gate must exit 0.
  const dir = mkdtempSync(join(tmpdir(), "xrt-gate-sdk-"));
  const path = writeDiff(dir, "sdk.json", buildCleanDiff());
  const out = runCli(["runner", "cross-runtime", "gate", "--diff", path]);
  assert.equal(out.status, 0, `expected 0, got ${out.status}; stderr=${out.stderr}`);
});

test("Tier 3C gate: invalid diff (bad JSON) → exit 3 (artifact_contract)", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-gate-bad-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "not json");
  const out = runCli(["runner", "cross-runtime", "gate", "--diff", path]);
  assert.equal(out.status, 3, `expected 3, got ${out.status}; stderr=${out.stderr}`);
  assert.match(out.stderr, /\[artifact_contract\].*invalid diff/);
});

test("Tier 3C gate: tampered binding_ids marker → exit 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-gate-tampered-"));
  const diff = buildCleanDiff();
  diff.binding_ids.comparison = "comparable_by_tool_call_id";
  const path = writeDiff(dir, "tampered.json", diff);
  const out = runCli(["runner", "cross-runtime", "gate", "--diff", path]);
  assert.equal(out.status, 3);
});

test("Tier 3C gate: missing --diff value → exit 2 (bare-flag guard)", () => {
  const out = runCli(["runner", "cross-runtime", "gate", "--diff"]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--diff.*required.*non-empty/);
});

test("Tier 3C gate: missing --diff entirely → exit 2", () => {
  const out = runCli(["runner", "cross-runtime", "gate"]);
  assert.equal(out.status, 2);
});

test("Tier 3C gate: file not found → exit 2 (config_error)", () => {
  const out = runCli([
    "runner",
    "cross-runtime",
    "gate",
    "--diff",
    "/nonexistent/path/diff.json",
  ]);
  assert.equal(out.status, 2);
});

test("Tier 3C gate: unknown runner cross-runtime subcommand → exit 2 with usage", () => {
  const out = runCli(["runner", "cross-runtime", "summarise", "--diff", "x"]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Usage:/);
  assert.match(out.stderr, /runner cross-runtime gate/);
});

test("Tier 3C gate: stdout stays clean (gate is exit-focused, not output-focused)", () => {
  const dir = mkdtempSync(join(tmpdir(), "xrt-gate-stdout-"));
  const path = writeDiff(dir, "clean.json", buildCleanDiff());
  const out = runCli(["runner", "cross-runtime", "gate", "--diff", path]);
  assert.equal(out.status, 0);
  assert.equal(
    out.stdout.trim(),
    "",
    `gate should not write to stdout; got: ${JSON.stringify(out.stdout)}`,
  );
});
