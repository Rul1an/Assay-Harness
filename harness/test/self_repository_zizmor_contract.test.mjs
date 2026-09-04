import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { load as loadYaml } from "js-yaml";

const HARNESS_CI = fileURLToPath(new URL("../../.github/workflows/harness-ci.yml", import.meta.url));
const ZIZMOR_WF = fileURLToPath(new URL("../../.github/workflows/zizmor.yml", import.meta.url));
const WORKFLOWS_DIR = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

const SELF_REPO_ACTION = "$/.github/actions/setup-node-harness";
const LEGACY_LOCAL_ACTION = "./.github/actions/setup-node-harness";
const EXPECTED_SELF_REPO_USES = 11;
const PINNED_ZIZMOR_VERSION = "1.30.0";


function read(path) {
  return readFileSync(path, "utf8");
}

function loadWorkflow(path) {
  return loadYaml(read(path));
}

function workflowYamlFiles(dir = WORKFLOWS_DIR) {
  return readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
}

function collectSetupNodeHarnessUses(harnessCiText) {
  const uses = [];
  for (const line of harnessCiText.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*uses:\s*(.+?)\s*$/);
    if (!m) continue;
    const ref = m[1];
    if (ref === SELF_REPO_ACTION || ref === LEGACY_LOCAL_ACTION) uses.push(ref);
  }
  return uses;
}

function requireSelfRepositoryUses(harnessCiText) {
  const uses = collectSetupNodeHarnessUses(harnessCiText);
  assert.equal(
    uses.length,
    EXPECTED_SELF_REPO_USES,
    `expected ${EXPECTED_SELF_REPO_USES} setup-node-harness uses, got ${uses.length}: ${uses.join(", ")}`,
  );
  for (const ref of uses) {
    assert.equal(ref, SELF_REPO_ACTION, `expected self-repository form, got ${ref}`);
  }
  assert.equal(
    harnessCiText.includes(LEGACY_LOCAL_ACTION),
    false,
    "legacy ./ workspace-relative setup-node-harness must be absent",
  );
  return uses;
}


function requireWorkflowEnumeration(dir = WORKFLOWS_DIR) {
  const files = workflowYamlFiles(dir);
  assert.ok(files.length > 0, "workflow enumerator must see at least one workflow file");
  assert.ok(files.includes("harness-ci.yml"), "enumerator must see harness-ci.yml");
  assert.ok(files.includes("zizmor.yml"), "enumerator must see zizmor.yml");
  for (const name of ["harness-ci.yml", "zizmor.yml"]) {
    const wf = loadYaml(read(`${dir}/${name}`));
    assert.ok(wf && typeof wf === "object", `${name} must parse as YAML object`);
    assert.ok(wf.jobs && Object.keys(wf.jobs).length > 0, `${name} must declare jobs`);
  }
  return files;
}

function zizmorJob(workflow = loadWorkflow(ZIZMOR_WF)) {
  const job = workflow.jobs?.zizmor;
  assert.ok(job, "missing zizmor job");
  return job;
}

function stepRuns(step) {
  return String(step?.run ?? "");
}

function stepName(step) {
  return String(step?.name ?? "");
}

function findInstallSteps(workflow = loadWorkflow(ZIZMOR_WF)) {
  return (zizmorJob(workflow).steps ?? []).filter((step) => {
    const run = stepRuns(step);
    const name = stepName(step).toLowerCase();
    return name.includes("install zizmor") || /pipx\s+install\s+["']?zizmor/.test(run);
  });
}

function isInstallReachableOnPrPush(step) {
  const ifExpr = String(step.if ?? "").trim();
  // No `if` → runs on every trigger, including PR/push.
  if (!ifExpr) return true;
  const hasPr = /pull_request/.test(ifExpr);
  const hasPush = /\bpush\b/.test(ifExpr);
  if (hasPr || hasPush) return true;
  // Explicit schedule/workflow_dispatch-only canary is not PR/push-reachable.
  const scheduleOnly =
    (/schedule/.test(ifExpr) || /workflow_dispatch/.test(ifExpr))
    && !hasPr
    && !hasPush;
  if (scheduleOnly) return false;
  // Unknown event guards fail closed as PR/push-reachable.
  return true;
}

function isPinnedPrPushInstallStep(step) {
  const run = stepRuns(step);
  const ifExpr = String(step.if ?? "");
  const envVersion = step.env?.ZIZMOR_VERSION;
  const hasLiteralPin = run.includes(`zizmor==${PINNED_ZIZMOR_VERSION}`);
  const hasEnvPin = envVersion === PINNED_ZIZMOR_VERSION && /pipx\s+install\s+"zizmor==\$\{ZIZMOR_VERSION\}"/.test(run);
  const hasPin = hasLiteralPin || hasEnvPin;
  const scopedToPrPush = /pull_request/.test(ifExpr) && /\bpush\b/.test(ifExpr);
  const echoesVersion = /echo\b/.test(run) && (/ZIZMOR_VERSION/.test(run) || run.includes(PINNED_ZIZMOR_VERSION));
  return hasPin && scopedToPrPush && echoesVersion;
}

function requirePinnedPrPushInstall(workflow = loadWorkflow(ZIZMOR_WF)) {
  const steps = findInstallSteps(workflow);
  assert.ok(steps.length >= 1, "expected at least one zizmor install step");

  // DoD: one reviewed, centrally pinned version on the PR/push path —
  // every install step reachable on PR/push must be that single pinned step.
  // An extra unpinned PR/push-scoped install is a false-green against "exactly one pinned".
  const prPushReachable = steps.filter(isInstallReachableOnPrPush);
  assert.equal(
    prPushReachable.length,
    1,
    `expected exactly one PR/push-reachable zizmor install step (one reviewed pin), got ${prPushReachable.length}`,
  );
  assert.ok(
    isPinnedPrPushInstallStep(prPushReachable[0]),
    "the sole PR/push-reachable install must be the pinned + version-echoed enforcement step",
  );

  const run = stepRuns(prPushReachable[0]);
  assert.match(run, /pipx\s+install/);
  assert.ok(
    run.includes(`zizmor==${PINNED_ZIZMOR_VERSION}`)
      || /zizmor==\$\{ZIZMOR_VERSION\}/.test(run),
    "PR/push install must pin zizmor with ==version",
  );
  assert.match(run, /echo\b/);
  return prPushReachable[0];
}

function requireFloatingCanaryInstall(workflow = loadWorkflow(ZIZMOR_WF)) {
  const steps = findInstallSteps(workflow);
  const floating = steps.filter((step) => {
    const run = stepRuns(step);
    const ifExpr = String(step.if ?? "");
    const unpinned = /pipx\s+install\s+zizmor\b/.test(run) && !/zizmor==/.test(run);
    const canary = /schedule/.test(ifExpr) && /workflow_dispatch/.test(ifExpr);
    return unpinned && canary;
  });
  assert.equal(floating.length, 1, `expected exactly one floating canary install step, got ${floating.length}`);
  // Floating canary must not be the required PR/push enforcement path.
  assert.doesNotMatch(String(floating[0].if ?? ""), /pull_request/);
  return floating[0];
}

function requireZizmorGateSurface(workflow = loadWorkflow(ZIZMOR_WF), text = read(ZIZMOR_WF)) {
  assert.ok(Object.hasOwn(workflow.on ?? {}, "pull_request"), "zizmor workflow must keep pull_request trigger");
  assert.match(text, /--min-confidence\s+high/, "high-confidence gate must remain");
  const upload = (zizmorJob(workflow).steps ?? []).find((step) =>
    String(step.uses ?? "").includes("github/codeql-action/upload-sarif")
  );
  assert.ok(upload, "SARIF upload step must remain");
  assert.equal(upload["continue-on-error"], true, "SARIF upload continue-on-error must remain");
}

test("harness-ci uses self-repository setup-node-harness for all 11 references", () => {
  requireSelfRepositoryUses(read(HARNESS_CI));
});

test("workflow enumerator surfaces harness-ci and zizmor contracts non-vacuously", () => {
  const files = requireWorkflowEnumeration();
  assert.ok(files.length >= 2, "expected multiple workflow files in enumeration");
});

test("PR/push zizmor install is pinned and version-echoed", () => {
  requirePinnedPrPushInstall();
});

test("scheduled/workflow_dispatch canary install stays explicitly floating", () => {
  requireFloatingCanaryInstall();
});

test("zizmor keeps PR trigger, high-confidence gate, and SARIF continue-on-error", () => {
  requireZizmorGateSurface();
});

test("mutation: restoring one ./ local action use fails the self-repository contract", () => {
  const original = read(HARNESS_CI);
  // Start from a GREEN-shaped text: if still on legacy, normalize one then re-break.
  let green = original.split(LEGACY_LOCAL_ACTION).join(SELF_REPO_ACTION);
  const uses = collectSetupNodeHarnessUses(green);
  assert.ok(uses.length >= 1, "need at least one self-repo use to mutate");
  const mutated = green.replace(SELF_REPO_ACTION, LEGACY_LOCAL_ACTION);
  assert.equal(mutated.includes(LEGACY_LOCAL_ACTION), true);
  assert.throws(() => requireSelfRepositoryUses(mutated), /self-repository|legacy|\.\/|got/);
});

test("mutation: zero-workflow enumeration fails rather than vacuously passing", () => {
  const dir = mkdtempSync(join(tmpdir(), "zizmor-empty-workflows-"));
  try {
    assert.throws(() => requireWorkflowEnumeration(dir), /enumerator must see|at least one workflow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation: extra unpinned PR/push install fails one-reviewed pin contract", () => {
  const base = loadWorkflow(ZIZMOR_WF);
  const dual = JSON.parse(JSON.stringify(base));
  // Clone/add a second PR/push-scoped install that stays unpinned — must not
  // leave the suite green while DoD requires one reviewed central pin.
  dual.jobs.zizmor.steps.push({
    name: "Install zizmor (rogue unpinned PR/push)",
    if: "steps.changes.outputs.audit_needed == 'true' && (github.event_name == 'pull_request' || github.event_name == 'push')",
    run: "set -euo pipefail\npipx install zizmor\n",
  });
  assert.throws(
    () => requirePinnedPrPushInstall(dual),
    /exactly one PR\/push-reachable|one reviewed pin|sole PR\/push-reachable/,
  );
});

test("mutation: unpinned PR/push install fails the pin contract", () => {
  const base = loadWorkflow(ZIZMOR_WF);
  const clone = () => JSON.parse(JSON.stringify(base));

  const unpinned = clone();
  for (const step of unpinned.jobs.zizmor.steps) {
    if (typeof step.run === "string" && step.run.includes("pipx install")) {
      step.run = step.run
        .replace(/pipx install ["']?zizmor==[^"' \n]+["']?/, "pipx install zizmor")
        .replace(/pipx install "zizmor==\$\{ZIZMOR_VERSION\}"/, "pipx install zizmor")
        .replace(/pipx install zizmor==\$\{ZIZMOR_VERSION\}/, "pipx install zizmor");
      if (step.env && "ZIZMOR_VERSION" in step.env) delete step.env.ZIZMOR_VERSION;
      // Force PR/push scope so the floating canary does not satisfy the pin rule.
      step.if = "steps.changes.outputs.audit_needed == 'true' && (github.event_name == 'pull_request' || github.event_name == 'push')";
      step.name = "Install zizmor (pinned PR/push enforcement)";
    }
  }
  assert.throws(() => requirePinnedPrPushInstall(unpinned), /pinned PR\/push|pin|zizmor==/);
});

test("mutation: removing PR trigger, high-confidence gate, or continue-on-error fails", () => {
  const base = loadWorkflow(ZIZMOR_WF);
  const text = read(ZIZMOR_WF);
  const clone = () => JSON.parse(JSON.stringify(base));

  const noPr = clone();
  delete noPr.on.pull_request;
  assert.throws(() => requireZizmorGateSurface(noPr, text), /pull_request/);

  const noConfidence = text.replaceAll("--min-confidence high", "--min-confidence medium");
  assert.throws(() => requireZizmorGateSurface(base, noConfidence), /high-confidence/);

  const noContinue = clone();
  for (const step of noContinue.jobs.zizmor.steps) {
    if (String(step.uses ?? "").includes("upload-sarif")) {
      delete step["continue-on-error"];
    }
  }
  assert.throws(() => requireZizmorGateSurface(noContinue, text), /continue-on-error/);
});
