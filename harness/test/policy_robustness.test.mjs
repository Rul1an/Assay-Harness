// Guards the policy-engine robustness fixes from PR4 of the audit series.
//
// Two surfaces:
//   - matchPattern() must escape every regex metacharacter in a glob pattern,
//     not just `.`. Pre-PR4, characters like `?`, `(`, `[` flowed through into
//     the generated regex and changed match semantics in surprising ways.
//   - PolicyEngine.fromFile() must reject structurally invalid YAML with a
//     precise field-path error, not a generic "missing required fields".
//
// Note on test shape:
//   PolicyEngine is closed-by-default: any tool that matches no rule is denied
//   with `rule_ref: null`. So `decision === 'deny'` alone does not prove that
//   a pattern matched. These tests assert on `rule_ref` instead, which is
//   `deny:<pattern>` only when a deny pattern actually matched, and `null`
//   when default-deny fired.

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PolicyEngine } from "../dist/policy.js";

function buildEngine(toolsOverride = {}) {
  return new PolicyEngine({
    version: "1.0",
    name: "test-policy",
    tools: {
      allow: [],
      deny: [],
      require_approval: [],
      ...toolsOverride,
    },
  });
}

function writePolicyYaml(contents) {
  const dir = mkdtempSync(join(tmpdir(), "assay-policy-test-"));
  const path = join(dir, "policy.yaml");
  writeFileSync(path, contents, "utf-8");
  return path;
}

function deniedByPattern(engine, toolName) {
  // True only when the engine matched a deny rule, not when default-deny fired.
  const r = engine.evaluateTool(toolName);
  return r.decision === "deny" && r.rule_ref !== null;
}

// --- matchPattern() regression tests ---

test("matchPattern: literal '?' in a pattern is treated as a literal character", () => {
  // Pre-PR4: pattern "tool*?" produced /^tool.*?$/ where ? makes .* non-greedy
  // and the final ? was eaten as a quantifier. Post-PR4 the trailing '?' is
  // literal, so the name must actually end with '?'.
  const engine = buildEngine({ deny: ["tool*?"] });
  assert.equal(deniedByPattern(engine, "tool?"), true, "should match literal '?'");
  assert.equal(deniedByPattern(engine, "toolX?"), true, "wildcard + literal '?' should match");
  // Without trailing '?' the deny pattern must NOT match.
  assert.equal(deniedByPattern(engine, "toolX"), false, "no trailing '?' means no match");
});

test("matchPattern: literal '(' and ')' do not act as a regex group", () => {
  const engine = buildEngine({ deny: ["tool*(name)"] });
  assert.equal(deniedByPattern(engine, "toolX(name)"), true, "literal parens must match");
  assert.equal(deniedByPattern(engine, "toolXname"), false, "without parens, no match");
});

test("matchPattern: literal '[' and ']' do not act as a character class", () => {
  const engine = buildEngine({ deny: ["shell*[ab]"] });
  assert.equal(deniedByPattern(engine, "shell.exec[ab]"), true);
  assert.equal(deniedByPattern(engine, "shell.execa"), false, "'a' alone must not match");
  assert.equal(deniedByPattern(engine, "shell.execb"), false, "'b' alone must not match");
});

test("matchPattern: literal '+' does not act as a quantifier", () => {
  const engine = buildEngine({ deny: ["t*+a"] });
  assert.equal(deniedByPattern(engine, "tX+a"), true);
  assert.equal(deniedByPattern(engine, "tXa"), false, "without literal '+', no match");
});

test("matchPattern: literal '^' and '$' inside a pattern do not anchor mid-string", () => {
  const engine = buildEngine({ deny: ["t*^a"] });
  assert.equal(deniedByPattern(engine, "tX^a"), true);
  assert.equal(deniedByPattern(engine, "ta"), false, "no literal '^' means no match");
});

test("matchPattern: legitimate wildcard usage still works after escaping", () => {
  const exact = buildEngine({ deny: ["read_file"] });
  assert.equal(deniedByPattern(exact, "read_file"), true);

  const prefix = buildEngine({ deny: ["mcp.*"] });
  assert.equal(deniedByPattern(prefix, "mcp.fetch"), true);
  assert.equal(deniedByPattern(prefix, "mcp.write_file"), true);
  assert.equal(deniedByPattern(prefix, "fs.read"), false);

  const suffix = buildEngine({ deny: ["*.readonly"] });
  assert.equal(deniedByPattern(suffix, "file.readonly"), true);
  assert.equal(deniedByPattern(suffix, "net.readonly"), true);
  assert.equal(deniedByPattern(suffix, "file.write"), false);

  const middle = buildEngine({ deny: ["tool.*.read"] });
  assert.equal(deniedByPattern(middle, "tool.x.read"), true);
  assert.equal(deniedByPattern(middle, "tool.foo.read"), true);
  assert.equal(deniedByPattern(middle, "tool.x.write"), false);
});

test("matchPattern: literal '.' in an exact pattern matches only the literal '.'", () => {
  // This pattern hits the exact-match branch, no regex involved.
  const engine = buildEngine({ deny: ["mcp.exec"] });
  assert.equal(deniedByPattern(engine, "mcp.exec"), true);
  assert.equal(deniedByPattern(engine, "mcpXexec"), false);
});

// --- PolicyEngine.fromFile() schema validation tests ---

test("fromFile: missing 'version' field produces an error mentioning 'version'", () => {
  const path = writePolicyYaml(`
name: test
tools:
  allow: []
  deny: []
  require_approval: []
`);
  assert.throws(
    () => PolicyEngine.fromFile(path),
    /version/i,
    "error must mention the missing 'version' field",
  );
});

test("fromFile: 'tools.allow' present but malformed produces a precise error path", () => {
  const path = writePolicyYaml(`
version: "1.0"
name: test
tools:
  allow: "not_an_array"
  deny: []
  require_approval: []
`);
  assert.throws(
    () => PolicyEngine.fromFile(path),
    /tools\.allow/,
    "error must surface the precise tools.allow field path",
  );
});

test("fromFile: missing 'tools' is rejected", () => {
  const path = writePolicyYaml(`
version: "1.0"
name: test
`);
  assert.throws(() => PolicyEngine.fromFile(path), /tools/);
});

test("fromFile: a valid minimal policy loads", () => {
  const path = writePolicyYaml(`
version: "1.0"
name: minimal
tools:
  allow:
    - read_file
  deny: []
  require_approval: []
`);
  const engine = PolicyEngine.fromFile(path);
  assert.equal(engine.evaluateTool("read_file").decision, "allow");
});

test("fromFile: 'mcp' section is optional and absent does not break loading", () => {
  const path = writePolicyYaml(`
version: "1.0"
name: no-mcp-section
tools:
  allow:
    - read_file
  deny: []
  require_approval: []
`);
  const engine = PolicyEngine.fromFile(path);
  assert.equal(engine.evaluateTool("read_file").decision, "allow");
});
