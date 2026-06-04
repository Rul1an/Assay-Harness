import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAIMS = join(HERE, "..", "..", "examples", "claims-eval-honesty", "claims.json");
const ANN = join(HERE, "..", "..", "examples", "claims-eval-honesty", "annotation.json");

function runCli(args) {
  return spawnSync("node", ["dist/cli.js", ...args], { cwd: join(HERE, ".."), encoding: "utf8" });
}

test("eval-honesty fixture: report renders the documented three outcomes", () => {
  const r = runCli(["runner", "claims", "report", "--claims", CLAIMS, "--annotation", ANN, "--format", "json"]);
  assert.equal(r.status, 0);
  const rep = JSON.parse(r.stdout);
  const byId = Object.fromEntries(rep.results.map((x) => [x.id, x]));
  assert.equal(byId["attempted-connection"].decision, "supported");
  assert.equal(byId["no-network-egress"].decision, "blocked");
  assert.equal(byId["no-network-egress"].reason, "coverage_cannot_prove_absence");
  assert.equal(byId["used-evidence-file"].decision, "blocked");
  assert.equal(byId["used-evidence-file"].reason, "observed_absent_contradicts_positive_claim");
  assert.equal(rep.passed, false);
});

test("eval-honesty fixture: gate exits 6", () => {
  const r = runCli(["runner", "claims", "gate", "--claims", CLAIMS, "--annotation", ANN]);
  assert.equal(r.status, 6);
});

const CLEAN_CLAIMS = join(HERE, "..", "..", "examples", "claims-clean", "claims.json");
const CLEAN_ANN = join(HERE, "..", "..", "examples", "claims-clean", "annotation.json");

test("clean fixture: all claims supported, gate exits 0", () => {
  const rep = JSON.parse(
    runCli(["runner", "claims", "report", "--claims", CLEAN_CLAIMS, "--annotation", CLEAN_ANN, "--format", "json"]).stdout,
  );
  assert.equal(rep.passed, true);
  assert.equal(rep.counts.supported, 2);
  assert.equal(rep.counts.blocked, 0);
  const gate = runCli(["runner", "claims", "gate", "--claims", CLEAN_CLAIMS, "--annotation", CLEAN_ANN]);
  assert.equal(gate.status, 0);
});
