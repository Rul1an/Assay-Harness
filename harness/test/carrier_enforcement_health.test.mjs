import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ENFORCEMENT_HEALTH_V1_SCHEMA,
  validateEnforcementHealthV1,
  buildEnforcementHealthReport,
  loadEnforcementHealthReport,
  formatEnforcementHealthMarkdown,
  formatEnforcementHealthJUnit,
  formatEnforcementHealthSarif,
} from "../dist/carrier_enforcement_health.js";
import { getCarrierAdapter } from "../dist/carrier_registry.js";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/enforcement-health-conformance/${name}`, import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("schema constant pins the producer contract + registry resolves the adapter", () => {
  assert.equal(ENFORCEMENT_HEALTH_V1_SCHEMA, "assay.enforcement_health.v1");
  assert.ok(getCarrierAdapter(ENFORCEMENT_HEALTH_V1_SCHEMA));
});

test("active with probe is clean and real_block_proven", () => {
  const r = buildEnforcementHealthReport(fixture("active-with-probe.conformance.json"));
  assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
  assert.equal(r.passed, true);
  assert.equal(r.status, "active");
  assert.equal(r.real_block_proven, true);
});

test("active without probe is clean, not real_block_proven", () => {
  const r = buildEnforcementHealthReport(fixture("active-no-probe.conformance.json"));
  assert.equal(r.passed, true);
  assert.equal(r.real_block_proven, false);
});

test("failed status is not clean", () => {
  const r = buildEnforcementHealthReport(fixture("failed.conformance.json"));
  assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
  assert.equal(r.passed, false);
  assert.equal(r.status, "failed");
});

test("validate rejects a wrong/unknown schema id", () => {
  const v = validateEnforcementHealthV1({ schema: "assay.enforcement_health.v2" });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_SCHEMA_MISMATCH");
});

test("validate rejects an unknown status", () => {
  const v = validateEnforcementHealthV1({
    schema: ENFORCEMENT_HEALTH_V1_SCHEMA, status: "maybe", mechanism: "landlock", scope: "x",
    policy_semantics: "allowlist",
    landlock: { abi: 4, no_new_privs_confirmed: true, restrict_self_confirmed: true },
    probe: null, non_claims: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CARRIER_STATUS_UNKNOWN"));
});

test("validate requires the probe key (null-over-absent discipline)", () => {
  const v = validateEnforcementHealthV1({
    schema: ENFORCEMENT_HEALTH_V1_SCHEMA, status: "active", mechanism: "landlock", scope: "x",
    policy_semantics: "allowlist",
    landlock: { abi: 4, no_new_privs_confirmed: true, restrict_self_confirmed: true },
    non_claims: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "CARRIER_PROBE_MISSING"));
});

test("validate rejects an out-of-range probe.blocked_port", () => {
  const v = validateEnforcementHealthV1({
    schema: ENFORCEMENT_HEALTH_V1_SCHEMA, status: "active", mechanism: "landlock", scope: "x",
    policy_semantics: "allowlist",
    landlock: { abi: 4, no_new_privs_confirmed: true, restrict_self_confirmed: true },
    probe: {
      kind: "real_block", transport: "ipv4", blocked_action: "tcp_connect",
      blocked_port: 70000, blocked_errno: "EACCES", listener_reached: false,
    },
    non_claims: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.path === "probe.blocked_port"));
});

test("loadEnforcementHealthReport reports not_found for a missing path", () => {
  assert.equal(loadEnforcementHealthReport("/nonexistent/x.json").not_found, true);
});

test("projections reflect active vs failed", () => {
  const active = buildEnforcementHealthReport(fixture("active-with-probe.conformance.json"));
  assert.match(formatEnforcementHealthMarkdown(active), /\*\*Status:\*\* OK/);
  assert.match(formatEnforcementHealthJUnit(active), /failures="0"/);
  assert.equal(JSON.parse(formatEnforcementHealthSarif(active)).runs[0].results.length, 0);

  const failed = buildEnforcementHealthReport(fixture("failed.conformance.json"));
  assert.match(formatEnforcementHealthMarkdown(failed), /ENFORCEMENT NOT ACTIVE/);
  const sarif = JSON.parse(formatEnforcementHealthSarif(failed));
  assert.equal(sarif.version, "2.1.0");
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === "assay.carrier.enforcement_health.failed"));
});

function runCli(...cliArgs) {
  return spawnSync(process.execPath, [CLI, "carrier", "enforcement-health", ...cliArgs], { encoding: "utf8" });
}

test("CLI exit codes: active=0, failed=6, wrong-schema=3, missing=2, bad-format=2", () => {
  assert.equal(runCli("--carrier", fixture("active-with-probe.conformance.json")).status, 0);
  assert.equal(runCli("--carrier", fixture("active-no-probe.conformance.json")).status, 0);
  assert.equal(runCli("--carrier", fixture("failed.conformance.json")).status, 6);
  assert.equal(runCli("--carrier", fixture("wrong-schema.conformance.json")).status, 3);
  assert.equal(runCli("--carrier", "/nonexistent/x.json").status, 2);
  assert.equal(runCli("--carrier", fixture("active-no-probe.conformance.json"), "--format", "xml").status, 2);
});

test("CLI: --format json emits only parseable JSON on stdout (no summary leak)", () => {
  const r = runCli("--carrier", fixture("active-with-probe.conformance.json"), "--format", "json");
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.validation.carrier.schema, ENFORCEMENT_HEALTH_V1_SCHEMA);
});
