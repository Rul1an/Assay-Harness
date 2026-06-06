import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLEAN = join(HERE, "..", "..", "examples", "coding-agent-sandbox", "events.json");
const DEGRADED = join(HERE, "..", "..", "examples", "coding-agent-sandbox", "events-degraded.json");

function runCli(args) {
  return spawnSync("node", ["dist/cli.js", ...args], { cwd: join(HERE, ".."), encoding: "utf8" });
}

test("runner sandbox report: summarizes observed effects", () => {
  const r = runCli(["runner", "sandbox", "report", "--events", CLEAN, "--format", "json"]);
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.fs_ops, 1);
  assert.equal(summary.fs_by_op.write, 1);
  assert.equal(summary.execs, 1);
  assert.equal(summary.degradations, 0);
});

test("runner sandbox gate: passes on a clean run", () => {
  const r = runCli(["runner", "sandbox", "gate", "--events", CLEAN]);
  assert.equal(r.status, 0, r.stderr);
});

test("runner sandbox gate: fails on a containment degradation", () => {
  const r = runCli(["runner", "sandbox", "gate", "--events", DEGRADED]);
  assert.equal(r.status, 6, `expected REGRESSION exit, got ${r.status}: ${r.stderr}`);
});

test("runner sandbox gate: --allow-degraded passes a degraded run", () => {
  const r = runCli(["runner", "sandbox", "gate", "--events", DEGRADED, "--allow-degraded"]);
  assert.equal(r.status, 0, r.stderr);
});

test("runner sandbox report: rejects a malformed events document", () => {
  const r = runCli(["runner", "sandbox", "report", "--events", join(HERE, "runner_sandbox.test.mjs")]);
  assert.equal(r.status, 3, `expected ARTIFACT_CONTRACT exit, got ${r.status}`);
});
