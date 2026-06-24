import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CODING_AGENT_EVIDENCE_EVENT_TYPE,
  validateCodingAgentEvent,
  buildCodingAgentReport,
  loadCodingAgentReport,
  formatCodingAgentMarkdown,
  deriveSignals,
} from "../dist/carrier_coding_agent.js";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/coding-agent/${name}`, import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// a complete, valid coding-agent evidence event (in scope, fully covered, independently observed)
function validEvent() {
  return {
    specversion: "1.0",
    type: CODING_AGENT_EVIDENCE_EVENT_TYPE,
    source: "urn:assay:coding-agent",
    id: "run_demo:0",
    time: "2026-06-24T00:00:00Z",
    datacontenttype: "application/json",
    assayrunid: "run_demo",
    assayseq: 0,
    assayproducer: "assay",
    assayproducerversion: "3.30.0",
    assaygit: "unknown",
    assaypii: false,
    assaysecrets: false,
    assaycontenthash: "sha256:" + "a".repeat(64),
    data: {
      declared_scope: {
        allowed_files: ["src/foo.py"],
        allowed_commands: ["pytest"],
        network: "denied",
        allowed_mcp_tools: ["fs.read"],
        expected_test_command: "pytest",
        authorized: true,
      },
      observed_effects: {
        files_changed: ["src/foo.py"],
        commands_executed: ["pytest"],
        network_attempts: [],
        mcp_tool_calls: ["fs.read"],
        test_observed: true,
      },
      coverage: {
        files: "observed",
        commands: "observed",
        network: "observed",
        mcp_tools: "observed",
        test: "observed",
      },
      source_class: "boundary_observed",
      non_claims: [
        "does_not_prove_code_correctness",
        "does_not_prove_agent_intent",
        "does_not_replace_human_review",
      ],
    },
  };
}

function reportFor(event) {
  const validation = validateCodingAgentEvent(event);
  return {
    carrier_path: "fixture",
    validation,
    content_hash: validation.event?.content_hash,
    signals: validation.event ? deriveSignals(validation.event) : undefined,
  };
}

test("event-type constant is the frozen producer id", () => {
  assert.equal(CODING_AGENT_EVIDENCE_EVENT_TYPE, "assay.coding_agent.evidence_pack.v0");
});

test("the committed valid event validates and its Markdown surfaces every section", () => {
  const r = buildCodingAgentReport(fixture("valid.event.json"));
  assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
  const md = formatCodingAgentMarkdown(r);
  for (const section of [
    /Declared scope/,
    /Observed effects/,
    /Coverage \(per surface\)/,
    /Review signals/,
    /Source-class basis/,
    /Non-claims/,
  ]) {
    assert.match(md, section);
  }
});

test("missing network in declared scope -> invalid carrier", () => {
  const e = validEvent();
  delete e.data.declared_scope.network;
  const v = validateCodingAgentEvent(e);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((x) => x.code === "CARRIER_NETWORK_POLICY_INVALID"));
});

test("missing network in coverage -> invalid carrier (absence stated, never omitted)", () => {
  const e = validEvent();
  delete e.data.coverage.network;
  const v = validateCodingAgentEvent(e);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((x) => x.code === "CARRIER_COVERAGE_SURFACE_MISSING"));
});

test("producer_reported source class is a recordable input, not converted to a verdict", () => {
  const e = validEvent();
  e.data.source_class = "producer_reported";
  const r = reportFor(e);
  assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
  assert.equal(r.signals.source_class_is_observed, false);
  const md = formatCodingAgentMarkdown(r);
  assert.match(md, /producer_reported/);
  assert.match(md, /self-attested/);
});

test("network absent + no attempts stays an explicit coverage gap, not a clean result", () => {
  const e = validEvent();
  e.data.coverage.network = "absent";
  e.data.observed_effects.network_attempts = [];
  const r = reportFor(e);
  assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
  assert.ok(r.signals.coverage_gaps.includes("network"));
  assert.ok(formatCodingAgentMarkdown(r).includes("`absent`"));
});

test("effects outside declared scope surface as review signals, not a gate", () => {
  const e = validEvent();
  e.data.observed_effects.files_changed = ["src/foo.py", "secrets.env"];
  e.data.observed_effects.network_attempts = ["api.example.com:443"];
  const r = reportFor(e);
  assert.deepEqual(r.signals.out_of_scope_files, ["secrets.env"]);
  assert.equal(r.signals.network_attempts_despite_denied, true);
});

test("descriptive only: report carries no verdict/sufficiency field; Markdown has no approval wording", () => {
  const r = buildCodingAgentReport(fixture("out-of-scope.event.json"));
  assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
  const serialized = JSON.stringify(r);
  for (const key of ['"verdict"', '"effect_sufficiency"', '"disposition"', '"policy_result"']) {
    assert.ok(!serialized.includes(key), `report must not carry ${key}`);
  }
  const md = formatCodingAgentMarkdown(r);
  assert.match(md, /not a gate and not a verdict/);
  for (const banned of [/\bapproved\b/i, /\bcompliant\b/i, /✅|❌/]) {
    assert.doesNotMatch(md, banned);
  }
});

test("wrong event type -> invalid carrier", () => {
  const v = validateCodingAgentEvent({ type: "assay.tool.decision", assaycontenthash: "sha256:" + "a".repeat(64), data: {} });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "CARRIER_TYPE_MISMATCH");
});

test("producer-faithful: reads the serialized assaycontenthash, not the Rust field name content_hash", () => {
  // a real Assay EvidenceEvent serializes content_hash as the CloudEvents extension `assaycontenthash`
  assert.equal(validateCodingAgentEvent(validEvent()).valid, true);
  // an event carrying only the Rust field name `content_hash` is not the wire shape -> invalid
  const wrongName = validEvent();
  wrongName.content_hash = wrongName.assaycontenthash;
  delete wrongName.assaycontenthash;
  const v = validateCodingAgentEvent(wrongName);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((x) => x.code === "CARRIER_CONTENT_HASH_INVALID"));
});

test("missing/short assaycontenthash -> invalid carrier", () => {
  const e = validEvent();
  e.assaycontenthash = "not-a-digest";
  const v = validateCodingAgentEvent(e);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((x) => x.code === "CARRIER_CONTENT_HASH_INVALID"));
});

test("Markdown escapes a pipe in a producer-supplied path so the table cannot break", () => {
  const e = validEvent();
  e.data.observed_effects.files_changed = ["src/a|b.py"];
  const md = formatCodingAgentMarkdown(reportFor(e));
  assert.ok(md.includes("a\\|b.py"));
});

test("loadCodingAgentReport reports not_found for a missing path", () => {
  assert.equal(loadCodingAgentReport("/nonexistent/x.json").not_found, true);
});

test("network 'allowed' policy wording never claims a denied policy", () => {
  const e = validEvent();
  e.data.declared_scope.network = "allowed";
  e.data.observed_effects.network_attempts = ["api.example.com:443"];
  const md = formatCodingAgentMarkdown(reportFor(e));
  assert.match(md, /network allowed/);
  assert.doesNotMatch(md, /against the denied policy/);
});

test("empty expected_test_command is rejected (no 'declared' vs 'none' contradiction)", () => {
  const e = validEvent();
  e.data.declared_scope.expected_test_command = "";
  const v = validateCodingAgentEvent(e);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((x) => x.code === "CARRIER_SCOPE_INVALID"));
});

function runCli(...cliArgs) {
  return spawnSync(process.execPath, [CLI, "carrier", "coding-agent", ...cliArgs], { encoding: "utf8" });
}

test("CLI: any valid event -> 0 (descriptive); wrong-type -> 3; missing -> 2; bad-format -> 2", () => {
  assert.equal(runCli("--carrier", fixture("valid.event.json")).status, 0);
  assert.equal(runCli("--carrier", fixture("out-of-scope.event.json")).status, 0);
  assert.equal(runCli("--carrier", fixture("wrong-type.event.json")).status, 3);
  assert.equal(runCli("--carrier", "/nonexistent/x.json").status, 2);
  assert.equal(runCli("--carrier", fixture("valid.event.json"), "--format", "xml").status, 2);
});

test("CLI: --format json emits only parseable JSON on stdout (no summary leak)", () => {
  const r = runCli("--carrier", fixture("out-of-scope.event.json"), "--format", "json");
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.validation.valid, true);
  assert.equal(parsed.signals.out_of_scope_files.length, 1);
});
