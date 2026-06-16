import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA,
  validateTokenPassthroughConformance,
  buildTokenPassthroughReport,
  loadTokenPassthroughReport,
  channelIssue,
  formatTokenPassthroughMarkdown,
  formatTokenPassthroughJUnit,
  formatTokenPassthroughSarif,
} from "../dist/carrier_token_passthrough.js";
import { getCarrierAdapter } from "../dist/carrier_registry.js";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/token-passthrough-conformance/${name}`, import.meta.url));
const CLI = "dist/cli.js";

test("schema constant pins the producer contract + registry resolves the adapter", () => {
  assert.equal(TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA, "assay.token_passthrough_conformance.v0");
  assert.ok(getCarrierAdapter(TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA));
});

test("validate accepts the producer consuming-path report", () => {
  const report = buildTokenPassthroughReport(fixture("clean.conformance.json"));
  assert.equal(report.validation.valid, true, JSON.stringify(report.validation.errors));
  assert.equal(report.passed, true);
});

test("validate rejects a wrong/unknown schema id", () => {
  const v = validateTokenPassthroughConformance({ schema: "assay.token_passthrough_conformance.v1" });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_SCHEMA_MISMATCH");
});

test("validate rejects a non-object", () => {
  const v = validateTokenPassthroughConformance(null);
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_NOT_OBJECT");
});

test("channelIssue: checked+leak / checked+pass-false flag; not_applicable + unchecked skip", () => {
  assert.equal(channelIssue({ channel: "h", checked: true, leak_count: 0, pass: true }), null);
  assert.equal(channelIssue({ channel: "h", checked: true, leak_count: 1, pass: false }), "leak_count=1");
  assert.equal(channelIssue({ channel: "h", checked: true, leak_count: 0, pass: false }), "pass=false");
  assert.equal(channelIssue({ channel: "e", checked: false, not_applicable: true, leak_count: 0 }), null);
  assert.equal(channelIssue({ channel: "u", checked: false, leak_count: 0 }), null);
});

test("gate: a checked channel that leaked makes the report not clean", () => {
  const report = buildTokenPassthroughReport(fixture("leak.conformance.json"));
  assert.equal(report.validation.valid, true);
  assert.equal(report.passed, false);
  assert.ok(report.channels.some((c) => c.issue !== null));
});

test("gate: a not_applicable channel never blocks the gate", () => {
  const report = buildTokenPassthroughReport(fixture("clean.conformance.json"));
  const env = report.channels.find((c) => c.channel.channel === "environment");
  assert.ok(env);
  assert.equal(env.issue, null);
});

test("loadTokenPassthroughReport reports not_found for a missing path", () => {
  assert.equal(loadTokenPassthroughReport("/nonexistent/x.json").not_found, true);
});

test("projections: markdown/junit/sarif reflect clean vs leaked", () => {
  const clean = buildTokenPassthroughReport(fixture("clean.conformance.json"));
  assert.match(formatTokenPassthroughMarkdown(clean), /\*\*Status:\*\* OK/);
  assert.match(formatTokenPassthroughJUnit(clean), /failures="0"/);
  assert.equal(JSON.parse(formatTokenPassthroughSarif(clean)).runs[0].results.length, 0);

  const leak = buildTokenPassthroughReport(fixture("leak.conformance.json"));
  assert.match(formatTokenPassthroughMarkdown(leak), /NOT CLEAN/);
  const sarif = JSON.parse(formatTokenPassthroughSarif(leak));
  assert.equal(sarif.version, "2.1.0");
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === "assay.carrier.token_passthrough.leak"));
});

function runCli(...cliArgs) {
  return spawnSync(process.execPath, [CLI, "carrier", "token-passthrough", ...cliArgs], { encoding: "utf8" });
}

test("CLI exit codes: clean=0, leak=6, wrong-schema=3, missing=2", () => {
  assert.equal(runCli("--carrier", fixture("clean.conformance.json")).status, 0);
  assert.equal(runCli("--carrier", fixture("leak.conformance.json")).status, 6);
  assert.equal(runCli("--carrier", fixture("wrong-schema.conformance.json")).status, 3);
  assert.equal(runCli("--carrier", "/nonexistent/x.json").status, 2);
});
