import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  RENDER_SAFETY_CONFORMANCE_SCHEMA,
  validateRenderSafetyConformance,
  buildRenderSafetyReport,
  loadRenderSafetyReport,
  sinkIssues,
  formatRenderSafetyMarkdown,
  formatRenderSafetyJUnit,
  formatRenderSafetySarif,
} from "../dist/carrier_render_safety.js";
import { getCarrierAdapter } from "../dist/carrier_registry.js";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/render-safety-conformance/${name}`, import.meta.url));
const CLI = "dist/cli.js";

test("schema constant pins the producer contract + registry resolves the adapter", () => {
  assert.equal(RENDER_SAFETY_CONFORMANCE_SCHEMA, "assay.render_safety_conformance.v0");
  assert.ok(getCarrierAdapter(RENDER_SAFETY_CONFORMANCE_SCHEMA));
});

test("validate accepts the real producer golden (all sinks clean)", () => {
  const report = buildRenderSafetyReport(fixture("clean.conformance.json"));
  assert.equal(report.validation.valid, true, JSON.stringify(report.validation.errors));
  assert.equal(report.passed, true);
  assert.equal(report.sinks.length, 6);
});

test("validate rejects a wrong/unknown schema id", () => {
  const v = validateRenderSafetyConformance({ schema: "assay.render_safety_conformance.v1" });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_SCHEMA_MISMATCH");
});

test("validate rejects a non-object", () => {
  const v = validateRenderSafetyConformance(42);
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_NOT_OBJECT");
});

test("sinkIssues flags each not-clean condition", () => {
  assert.deepEqual(
    sinkIssues({
      sink: "stdout", renderer: "assay-core", hostile_probe_count: 1, benign_control_count: 1,
      raw_secret_leak_count: 0, raw_pii_leak_count: 0, terminal_control_leak_count: 0,
      redaction_before_truncation: true, benign_preserved: true, sink_specific_encoding: "x",
    }),
    [],
  );
  const issues = sinkIssues({
    sink: "stdout", renderer: "assay-core", hostile_probe_count: 1, benign_control_count: 1,
    raw_secret_leak_count: 2, raw_pii_leak_count: 0, terminal_control_leak_count: 0,
    redaction_before_truncation: false, benign_preserved: false, sink_specific_encoding: "x",
  });
  assert.ok(issues.some((i) => i.startsWith("raw_secret_leak_count=2")));
  assert.ok(issues.includes("redaction_before_truncation=false"));
  assert.ok(issues.includes("benign_preserved=false"));
});

test("gate: a raw leak makes the report not clean", () => {
  const report = buildRenderSafetyReport(fixture("leak.conformance.json"));
  assert.equal(report.validation.valid, true);
  assert.equal(report.passed, false);
  assert.ok(report.sinks.some((s) => s.issues.length > 0));
});

test("gate: truncation-before-redaction makes the report not clean", () => {
  const report = buildRenderSafetyReport(fixture("truncation-order.conformance.json"));
  assert.equal(report.passed, false);
  assert.ok(report.sinks[0].issues.includes("redaction_before_truncation=false"));
});

test("loadRenderSafetyReport reports not_found for a missing path", () => {
  assert.equal(loadRenderSafetyReport("/nonexistent/x.json").not_found, true);
});

test("projections: markdown/junit/sarif reflect clean vs not-clean", () => {
  const clean = buildRenderSafetyReport(fixture("clean.conformance.json"));
  assert.match(formatRenderSafetyMarkdown(clean), /\*\*Status:\*\* OK/);
  assert.match(formatRenderSafetyJUnit(clean), /failures="0"/);
  assert.equal(JSON.parse(formatRenderSafetySarif(clean)).runs[0].results.length, 0);

  const leak = buildRenderSafetyReport(fixture("leak.conformance.json"));
  assert.match(formatRenderSafetyMarkdown(leak), /NOT CLEAN/);
  const sarif = JSON.parse(formatRenderSafetySarif(leak));
  assert.equal(sarif.version, "2.1.0");
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === "assay.carrier.render_safety.raw_leak"));
});

function runCli(...cliArgs) {
  return spawnSync(process.execPath, [CLI, "carrier", "render-safety", ...cliArgs], { encoding: "utf8" });
}

test("CLI exit codes: clean=0, leak=6, truncation-order=6, wrong-schema=3, missing=2", () => {
  assert.equal(runCli("--carrier", fixture("clean.conformance.json")).status, 0);
  assert.equal(runCli("--carrier", fixture("leak.conformance.json")).status, 6);
  assert.equal(runCli("--carrier", fixture("truncation-order.conformance.json")).status, 6);
  assert.equal(runCli("--carrier", fixture("wrong-schema.conformance.json")).status, 3);
  assert.equal(runCli("--carrier", "/nonexistent/x.json").status, 2);
});

test("CLI: invalid --format -> exit 2 (config_error)", () => {
  assert.equal(runCli("--carrier", fixture("clean.conformance.json"), "--format", "xml").status, 2);
});

test("junit replaces XML-forbidden control characters with U+FFFD", () => {
  const ctrl = String.fromCharCode(1);
  const report = {
    carrier_path: "x",
    validation: {
      valid: true,
      errors: [],
      carrier: { schema: RENDER_SAFETY_CONFORMANCE_SCHEMA, corpus_digest: "x", sinks: [] },
    },
    passed: false,
    sinks: [
      {
        sink: {
          sink: `std${ctrl}out`,
          renderer: "assay-core",
          hostile_probe_count: 1,
          benign_control_count: 1,
          raw_secret_leak_count: 1,
          raw_pii_leak_count: 0,
          terminal_control_leak_count: 0,
          redaction_before_truncation: true,
          benign_preserved: true,
          sink_specific_encoding: "x",
        },
        issues: ["raw_secret_leak_count=1"],
      },
    ],
  };
  const junit = formatRenderSafetyJUnit(report);
  assert.ok(!junit.includes(ctrl), "XML-forbidden control byte must be stripped");
  assert.ok(junit.includes("�"), "stripped control byte is replaced with U+FFFD");
});
