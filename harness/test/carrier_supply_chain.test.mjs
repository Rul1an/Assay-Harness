import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SUPPLY_CHAIN_CONFORMANCE_SCHEMA,
  KNOWN_CHECK_STATUSES,
  KNOWN_POLICY_RESULTS,
  validateSupplyChainConformance,
  buildSupplyChainReport,
  loadSupplyChainReport,
  formatSupplyChainMarkdown,
  formatSupplyChainJUnit,
  formatSupplyChainSarif,
} from "../dist/carrier_supply_chain.js";
import {
  getCarrierAdapter,
  registeredCarrierSchemas,
  peekCarrierSchema,
} from "../dist/carrier_registry.js";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/supply-chain-conformance/${name}`, import.meta.url));
const CLI = "dist/cli.js";

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

test("schema + frozen status/policy sets pin the v3.27.0 producer contract", () => {
  assert.equal(SUPPLY_CHAIN_CONFORMANCE_SCHEMA, "assay.supply_chain_conformance.v0");
  for (const s of ["verified", "failed", "not_present", "not_applicable", "unsupported_format",
    "trust_root_unavailable", "online_required", "policy_not_satisfied", "subject_digest_mismatch",
    "identity_mismatch", "not_checked"]) {
    assert.ok(KNOWN_CHECK_STATUSES.includes(s), `status ${s} must be known`);
  }
  assert.deepEqual([...KNOWN_POLICY_RESULTS], ["pass", "fail", "incomplete"]);
});

// ---------------------------------------------------------------------------
// Validation (library)
// ---------------------------------------------------------------------------

test("validate accepts a real pass carrier", () => {
  const report = buildSupplyChainReport(fixture("pass.conformance.json"));
  assert.equal(report.validation.valid, true);
  assert.equal(report.policy_result, "pass");
  assert.equal(report.passed, true);
});

test("validate accepts the keyless (v3.27.0 append-only dimensions) carrier", () => {
  const report = buildSupplyChainReport(fixture("keyless.conformance.json"));
  assert.equal(report.validation.valid, true, JSON.stringify(report.validation.errors));
  assert.equal(report.passed, true);
  // The MCP04a-3.4 keyless dimensions parse and project (append-only key set).
  const names = report.dimensions.filter((d) => d.group === "provenance").map((d) => d.name);
  for (const k of ["cert_chain", "identity", "dsse_pae", "timestamp_freshness", "consistency", "witnessing"]) {
    assert.ok(names.includes(k), `keyless dimension ${k} must parse`);
  }
  // not_checked classifies as pending (unresolved), never verified.
  const ts = report.dimensions.find((d) => d.name === "timestamp_freshness");
  assert.equal(ts.class, "pending");
});

test("validate rejects a wrong/unknown schema id", () => {
  const v = validateSupplyChainConformance({ schema: "assay.supply_chain_conformance.v1" });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_SCHEMA_MISMATCH");
});

test("validate rejects a non-object", () => {
  const v = validateSupplyChainConformance("not an object");
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_NOT_OBJECT");
});

test("validate rejects an unknown CheckStatus (forward-compat guard)", () => {
  const report = buildSupplyChainReport(fixture("unknown-status.conformance.json"));
  assert.equal(report.validation.valid, false);
  assert.ok(report.validation.errors.some((e) => e.code === "CARRIER_STATUS_UNKNOWN"));
  assert.equal(report.passed, false);
});

test("validate rejects an unknown policy_result", () => {
  const v = validateSupplyChainConformance({
    schema: SUPPLY_CHAIN_CONFORMANCE_SCHEMA,
    subject: { name: "p", version: "1", digest: "sha256:0" },
    checks: {
      integrity: { artifact_digest: "verified", subject_digest_binding: "verified" },
      provenance: { dsse_signature: "not_present" },
      pinning: { version_pinned: "verified" },
    },
    declared: { required_slsa_build_level: "L1" },
    verified: { slsa_build_level: "L1" },
    policy_result: "maybe",
    coverage: { sources_checked: [], limits: [] },
    non_claims: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CARRIER_POLICY_RESULT_UNKNOWN"));
});

test("validate rejects a missing checks group", () => {
  const v = validateSupplyChainConformance({
    schema: SUPPLY_CHAIN_CONFORMANCE_SCHEMA,
    subject: { name: "p", version: "1", digest: "sha256:0" },
    checks: { integrity: { artifact_digest: "verified" } },
    declared: { required_slsa_build_level: "L1" },
    verified: { slsa_build_level: "L0" },
    policy_result: "incomplete",
    coverage: { sources_checked: [], limits: [] },
    non_claims: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CARRIER_CHECK_GROUP_MISSING"));
});

// ---------------------------------------------------------------------------
// Gate (library): producer-owned policy_result drives passed
// ---------------------------------------------------------------------------

test("gate: fail carrier is not clean and surfaces blocking dimensions", () => {
  const report = buildSupplyChainReport(fixture("fail.conformance.json"));
  assert.equal(report.validation.valid, true);
  assert.equal(report.policy_result, "fail");
  assert.equal(report.passed, false);
  assert.ok(report.counts.blocking > 0, "fail carrier must have at least one blocking dimension");
});

test("gate: incomplete carrier is never clean", () => {
  const report = buildSupplyChainReport(fixture("incomplete.conformance.json"));
  assert.equal(report.policy_result, "incomplete");
  assert.equal(report.passed, false);
});

test("gate: unsupported-format carrier is incomplete and not clean", () => {
  const report = buildSupplyChainReport(fixture("unsupported.conformance.json"));
  assert.equal(report.policy_result, "incomplete");
  assert.equal(report.passed, false);
  assert.ok(report.dimensions.some((d) => d.status === "unsupported_format"));
});

test("loadSupplyChainReport reports not_found for a missing path", () => {
  const load = loadSupplyChainReport("/nonexistent/carrier.json");
  assert.equal(load.ok, false);
  assert.equal(load.not_found, true);
});

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

test("markdown: pass -> OK, fail -> FAIL, and never uses alarmist wording", () => {
  const pass = formatSupplyChainMarkdown(buildSupplyChainReport(fixture("pass.conformance.json")));
  assert.match(pass, /\*\*Status:\*\* OK/);

  const fail = formatSupplyChainMarkdown(buildSupplyChainReport(fixture("fail.conformance.json")));
  assert.match(fail, /\*\*Status:\*\* SUPPLY-CHAIN CONFORMANCE FAIL/);
  assert.match(fail, /Blocking dimensions/);

  // Boundary discipline: surface the carrier's verdict, never invent threat language
  // or approval/compliance claims.
  for (const banned of [/compromised/i, /attack detected/i, /\bapproved\b/i, /\bcompliant\b/i, /trusted provider/i]) {
    assert.doesNotMatch(fail, banned);
    assert.doesNotMatch(pass, banned);
  }
});

test("junit: pass has zero failures; incomplete fails the policy_result case", () => {
  const pass = formatSupplyChainJUnit(buildSupplyChainReport(fixture("pass.conformance.json")));
  assert.match(pass, /failures="0"/);

  const incomplete = formatSupplyChainJUnit(buildSupplyChainReport(fixture("incomplete.conformance.json")));
  assert.doesNotMatch(incomplete, /failures="0"/);
  assert.match(incomplete, /name="policy_result"/);
});

test("sarif: emits 2.1.0 with namespaced carrier rule ids and never on a clean carrier", () => {
  const fail = formatSupplyChainSarif(buildSupplyChainReport(fixture("fail.conformance.json")));
  const parsed = JSON.parse(fail);
  assert.equal(parsed.version, "2.1.0");
  const ruleIds = parsed.runs[0].tool.driver.rules.map((r) => r.id);
  assert.ok(ruleIds.includes("assay.carrier.supply_chain.failed"));
  assert.ok(parsed.runs[0].results.some((r) => r.ruleId === "assay.carrier.supply_chain.failed"));

  const pass = JSON.parse(formatSupplyChainSarif(buildSupplyChainReport(fixture("pass.conformance.json"))));
  assert.equal(pass.runs[0].results.length, 0, "a clean carrier produces no SARIF findings");
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry resolves the supply-chain adapter and rejects unknown schemas", () => {
  assert.ok(getCarrierAdapter(SUPPLY_CHAIN_CONFORMANCE_SCHEMA));
  assert.equal(getCarrierAdapter("assay.unknown_carrier.v0"), undefined);
  // own-property lookup: a prototype key must never resolve to an adapter
  assert.equal(getCarrierAdapter("toString"), undefined);
  assert.equal(getCarrierAdapter("constructor"), undefined);
  assert.ok(registeredCarrierSchemas().includes(SUPPLY_CHAIN_CONFORMANCE_SCHEMA));
  assert.equal(peekCarrierSchema({ schema: "x" }), "x");
  assert.equal(peekCarrierSchema("nope"), undefined);
});

// ---------------------------------------------------------------------------
// CLI exit-code contract (spawn the built binary)
// ---------------------------------------------------------------------------

function runCli(...cliArgs) {
  return spawnSync(process.execPath, [CLI, "carrier", "supply-chain", ...cliArgs], {
    encoding: "utf8",
  });
}

test("CLI: pass carrier -> exit 0", () => {
  const r = runCli("--carrier", fixture("pass.conformance.json"));
  assert.equal(r.status, 0, r.stderr);
});

test("CLI: fail carrier -> exit 6 (regression)", () => {
  const r = runCli("--carrier", fixture("fail.conformance.json"));
  assert.equal(r.status, 6, r.stderr);
});

test("CLI: incomplete carrier -> exit 6 (incomplete is never clean)", () => {
  const r = runCli("--carrier", fixture("incomplete.conformance.json"));
  assert.equal(r.status, 6, r.stderr);
});

test("CLI: unknown status -> exit 3 (artifact_contract)", () => {
  const r = runCli("--carrier", fixture("unknown-status.conformance.json"));
  assert.equal(r.status, 3, r.stderr);
});

test("CLI: wrong schema -> exit 3 (artifact_contract)", () => {
  const r = runCli("--carrier", fixture("wrong-schema.conformance.json"));
  assert.equal(r.status, 3, r.stderr);
});

test("CLI: missing carrier file -> exit 2 (config_error)", () => {
  const r = runCli("--carrier", "/nonexistent/carrier.json");
  assert.equal(r.status, 2, r.stderr);
});

test("CLI: bare carrier verb -> exit 2 (config_error)", () => {
  const r = spawnSync(process.execPath, [CLI, "carrier"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
});
