// Guards the recursive forbidden-key scan added to the verify command.
//
// Audit at commit 31669dc found that the verifier only checked rejected
// keys directly under `event.data`, so nested shapes like
// `data.observed.raw_run_state` slipped through. PR1 of the follow-up
// audit replaced the shallow check with a recursive walk over the full
// `event.data` object graph, and split the forbidden set into two
// categories with distinct error codes:
//
//   VERIFY_FORBIDDEN_RUNTIME_KEY — raw SDK state (raw_run_state, history,
//     newItems, lastResponseId, session)
//
//   VERIFY_FORBIDDEN_PAYLOAD_KEY — raw payload bodies (raw_arguments,
//     raw_output, transcript, audio_blob, session_recording,
//     request_payload, response_payload, raw_payload)
//
// These tests pin both the recursive walk and the category split.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const harnessRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(harnessRoot, "src", "cli.ts");

function writeEventLine(event) {
  const dir = mkdtempSync(join(tmpdir(), "assay-verify-recursive-"));
  const path = join(dir, "events.ndjson");
  writeFileSync(path, JSON.stringify(event) + "\n", "utf-8");
  return path;
}

function runVerify(eventsPath) {
  const result = spawnSync(
    "npx",
    ["tsx", cliEntry, "verify", eventsPath, "--category", "type"],
    { cwd: harnessRoot, encoding: "utf8", timeout: 30_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function buildEnvelope(data) {
  return {
    specversion: "1.0",
    type: "assay.harness.policy-decision",
    source: "urn:assay:harness:test",
    id: "test-run:0",
    time: "2026-05-11T00:00:00Z",
    datacontenttype: "application/json",
    assayrunid: "test-run",
    assayseq: 0,
    assayproducer: "assay-harness",
    assayproducerversion: "0.3.2",
    assaygit: "test",
    assaypii: false,
    assaysecrets: false,
    assaycontenthash: "sha256:test",
    data,
  };
}

// --- Top-level (regression: pre-PR behaviour must still work) ---

test("top-level raw_run_state under data still rejected", () => {
  const path = writeEventLine(buildEnvelope({ raw_run_state: { foo: "bar" } }));
  const r = runVerify(path);
  assert.notEqual(r.status, 0, "verify must fail");
  assert.match(r.stdout, /VERIFY_FORBIDDEN_RUNTIME_KEY/);
  assert.match(r.stdout, /raw_run_state/);
});

// --- Recursive: the gap the audit identified ---

test("nested raw_run_state under data.observed is rejected", () => {
  const path = writeEventLine(buildEnvelope({
    observed: { raw_run_state: { foo: "bar" } },
  }));
  const r = runVerify(path);
  assert.notEqual(r.status, 0, "verify must fail on nested forbidden key");
  assert.match(r.stdout, /VERIFY_FORBIDDEN_RUNTIME_KEY/);
  assert.match(r.stdout, /data\.observed\.raw_run_state/);
});

test("deeply nested raw_run_state is rejected", () => {
  const path = writeEventLine(buildEnvelope({
    a: { b: { c: { raw_run_state: {} } } },
  }));
  const r = runVerify(path);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /VERIFY_FORBIDDEN_RUNTIME_KEY/);
  assert.match(r.stdout, /data\.a\.b\.c\.raw_run_state/);
});

test("forbidden key inside an array element is rejected with bracket-index path", () => {
  const path = writeEventLine(buildEnvelope({
    samples: [
      { ok: true },
      { ok: false, raw_arguments: { secret: "leak" } },
    ],
  }));
  const r = runVerify(path);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /VERIFY_FORBIDDEN_PAYLOAD_KEY/);
  assert.match(r.stdout, /data\.samples\[1\]\.raw_arguments/);
});

// --- Category split: distinct error codes ---

test("raw_run_state produces VERIFY_FORBIDDEN_RUNTIME_KEY", () => {
  const path = writeEventLine(buildEnvelope({ observed: { raw_run_state: {} } }));
  const r = runVerify(path);
  assert.match(r.stdout, /VERIFY_FORBIDDEN_RUNTIME_KEY/);
  assert.doesNotMatch(r.stdout, /VERIFY_FORBIDDEN_PAYLOAD_KEY/);
});

test("raw_arguments produces VERIFY_FORBIDDEN_PAYLOAD_KEY", () => {
  const path = writeEventLine(buildEnvelope({ observed: { raw_arguments: { x: 1 } } }));
  const r = runVerify(path);
  assert.match(r.stdout, /VERIFY_FORBIDDEN_PAYLOAD_KEY/);
  assert.doesNotMatch(r.stdout, /VERIFY_FORBIDDEN_RUNTIME_KEY/);
});

test("request_payload and response_payload are payload-class forbidden", () => {
  const path1 = writeEventLine(buildEnvelope({ observed: { request_payload: "..." } }));
  const r1 = runVerify(path1);
  assert.match(r1.stdout, /VERIFY_FORBIDDEN_PAYLOAD_KEY/);
  assert.match(r1.stdout, /request_payload/);

  const path2 = writeEventLine(buildEnvelope({ observed: { response_payload: "..." } }));
  const r2 = runVerify(path2);
  assert.match(r2.stdout, /VERIFY_FORBIDDEN_PAYLOAD_KEY/);
  assert.match(r2.stdout, /response_payload/);
});

test("transcript and audio_blob are payload-class forbidden", () => {
  const path1 = writeEventLine(buildEnvelope({ observed: { transcript: "user said hi" } }));
  const r1 = runVerify(path1);
  assert.match(r1.stdout, /VERIFY_FORBIDDEN_PAYLOAD_KEY/);
  assert.match(r1.stdout, /transcript/);

  const path2 = writeEventLine(buildEnvelope({ session: { audio_blob: "binary" } }));
  const r2 = runVerify(path2);
  // session itself is a runtime key, so we expect runtime error; the
  // audio_blob nested inside it is descended into and would also fire
  // a payload error. Both must be reported.
  assert.match(r2.stdout, /VERIFY_FORBIDDEN_RUNTIME_KEY/);
  assert.match(r2.stdout, /VERIFY_FORBIDDEN_PAYLOAD_KEY/);
});

// --- Allow-list sanity (legitimate hashed fields must NOT trigger) ---

test("hashed fields are allowed alongside their forbidden raw counterparts", () => {
  // arguments_hash + output_hash are the content-addressed substitutes
  // for raw_arguments / raw_output. They must pass verify.
  const path = writeEventLine(buildEnvelope({
    arguments_hash: "sha256:abc",
    output_hash: "sha256:def",
    tool_name: "shell.exec",
  }));
  const r = runVerify(path);
  assert.equal(r.status, 0, `verify must pass on hash-only fields, got: ${r.stdout}`);
});

test("a normal allowed payload (policy-decision shape) passes verify", () => {
  const path = writeEventLine(buildEnvelope({
    decision: "allow",
    policy_id: "p@1",
    action_kind: "tool_call",
    target_ref: "read_file",
    rule_ref: "allow:read_file",
    timestamp: "2026-05-11T00:00:00Z",
  }));
  const r = runVerify(path);
  assert.equal(r.status, 0, `verify must pass on a clean policy-decision payload, got: ${r.stdout}`);
});
