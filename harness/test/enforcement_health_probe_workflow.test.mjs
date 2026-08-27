import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { load as loadYaml } from "js-yaml";

const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/harness-ci.yml", import.meta.url));
const WORKFLOWS_DIR = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const PROMOTION_WORKFLOW = fileURLToPath(
  new URL("../../.github/workflows/enforcement-health-promotion.yml", import.meta.url),
);
const POLICY = fileURLToPath(
  new URL("../fixtures/suite-compatibility/enforcement-health/probe-policy.yaml", import.meta.url),
);
const PINNED_ASSET_DIGEST = "sha256:352cd390dc59fb5adacecae5adf51976419f18ae50918f8f1504952869e94ad3";
const RECIPE_JOBS = [
  "assay-release-compatibility",
  "assay-inventory-recipe",
  "assay-supply-chain-recipe",
  "assay-supply-chain-dsse-recipe",
];
const RECIPE_IF = "github.event_name == 'workflow_dispatch' && !inputs.probe_only";
const PROBE_IF = "github.event_name == 'workflow_dispatch' && inputs.probe_only";
const MINIMAL_POLICY = `api_version: "assay/v1"
fs:
  allow: []
  deny: []
net:
  allow:
    - "443"
  deny: []
`;

function loadWorkflow() {
  return loadYaml(readFileSync(WORKFLOW, "utf8"));
}

function loadPromotionWorkflow() {
  return loadYaml(readFileSync(PROMOTION_WORKFLOW, "utf8"));
}

function job(workflow, id) {
  const found = workflow.jobs?.[id];
  assert.ok(found, `missing job ${id}`);
  return found;
}

function reachableOn(expr, eventName, probeOnly) {
  const dispatch = eventName === "workflow_dispatch";
  if (expr === RECIPE_IF) return dispatch && !probeOnly;
  if (expr === PROBE_IF) return dispatch && !!probeOnly;
  assert.fail(`unpinned if expression: ${expr}`);
}

test("probe_only dispatch input defaults to current recipe dispatch", () => {
  const workflow = loadWorkflow();
  const input = workflow.on.workflow_dispatch.inputs.probe_only;
  assert.ok(input, "workflow_dispatch.inputs.probe_only is required");
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  assert.equal(input.required, false);
});

test("probe-only job is reachable only for probe-only dispatch on hosted ubuntu x86_64", () => {
  const workflow = loadWorkflow();
  const probe = job(workflow, "assay-enforcement-health-probe");
  assert.equal(probe["runs-on"], "ubuntu-latest");
  assert.equal(probe.if, PROBE_IF);
  assert.equal(reachableOn(probe.if, "workflow_dispatch", true), true);
  assert.equal(reachableOn(probe.if, "workflow_dispatch", false), false);
  assert.equal(reachableOn(probe.if, "pull_request", true), false);
  assert.equal(reachableOn(probe.if, "push", false), false);
});

test("recipe dispatch stays on by default and is suppressed only in probe-only mode", () => {
  const workflow = loadWorkflow();
  for (const id of RECIPE_JOBS) {
    const recipe = job(workflow, id);
    assert.equal(recipe.if, RECIPE_IF, id);
    assert.equal(reachableOn(recipe.if, "workflow_dispatch", false), true, id);
    assert.equal(reachableOn(recipe.if, "workflow_dispatch", true), false, id);
    assert.equal(reachableOn(recipe.if, "pull_request", false), false, id);
  }
});

test("probe is not always-on for pull_request or push", () => {
  const raw = readFileSync(WORKFLOW, "utf8");
  const workflow = loadWorkflow();
  const probe = job(workflow, "assay-enforcement-health-probe");
  assert.equal(Object.hasOwn(workflow.on, "pull_request"), true);
  assert.doesNotMatch(String(probe.if ?? ""), /pull_request/);
  assert.equal(raw.includes("if: github.event_name == 'pull_request' && inputs.probe_only"), false);
});

test("probe job pins the v5.4.0 x86_64 asset, verifies the sidecar, and keeps digests distinct", () => {
  const probe = job(loadWorkflow(), "assay-enforcement-health-probe");
  const download = (probe.steps ?? []).map((step) => String(step.run ?? "")).join("\n");
  assert.match(download, /v5\.4\.0/);
  assert.match(download, /x86_64-unknown-linux-gnu\.tar\.gz/);
  assert.match(download, new RegExp(PINNED_ASSET_DIGEST.replaceAll(".", "\\.")));
  assert.match(download, /sha256sum -c /);
  assert.match(download, /sha256sum "\$bin"/);
  assert.match(download, /distinct from release asset digest/);
  assert.doesNotMatch(download, /--fail-closed/);
});

test("probe job runs the committed probe script and consumes the carrier", () => {
  const probe = job(loadWorkflow(), "assay-enforcement-health-probe");
  const body = (probe.steps ?? []).map((step) => String(step.run ?? "")).join("\n");
  assert.match(body, /scripts\/probe-v54-enforcement-health\.mjs/);
  assert.match(body, /--expected-digest/);
  assert.match(body, /--policy /);
  assert.match(body, /fixtures\/suite-compatibility\/enforcement-health\/probe-policy\.yaml/);
  assert.match(body, /carrier enforcement-health --carrier /);
  assert.match(body, /enforcement_health_record_cli\.ts/);
  assert.doesNotMatch(body, /assay sandbox /);
  assert.doesNotMatch(body, /--fail-closed/);
});

test("probe job uploads carrier and provenance and fails if they are missing", () => {
  const probe = job(loadWorkflow(), "assay-enforcement-health-probe");
  const upload = (probe.steps ?? []).find((step) => {
    const uses = String(step.uses ?? "");
    return uses.startsWith("actions/upload-artifact@") && String(step.with?.name ?? "").includes("enforcement-health");
  });
  assert.ok(upload, "missing enforcement-health upload-artifact step");
  const paths = String(upload.with.path);
  assert.match(paths, /enforcement-health\.json/);
  assert.match(paths, /recipe\.provenance\.json/);
  assert.equal(upload.with["if-no-files-found"], "error");
});

test("committed policy fixture is the minimal 443 allowlist", () => {
  assert.equal(readFileSync(POLICY, "utf8"), MINIMAL_POLICY);
});

test("the PR-tree workflow cannot emit the promotion check", () => {
  assert.equal(loadWorkflow().jobs?.["enforcement-health-promotion"], undefined);
});

test("the promotion check name is unique to the trusted workflow across the repository", () => {
  const owners = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const workflow = loadYaml(readFileSync(`${WORKFLOWS_DIR}/${file}`, "utf8"));
    for (const [id, candidate] of Object.entries(workflow.jobs ?? {})) {
      if (candidate?.name === "Enforcement Health Promotion") owners.push(`${file}:${id}`);
    }
  }
  assert.deepEqual(owners, ["enforcement-health-promotion.yml:enforcement-health-promotion"]);
});

test("promotion runs from a base-owned pull_request_target workflow with least privilege", () => {
  const workflow = loadPromotionWorkflow();
  assert.deepEqual(Object.keys(workflow.on), ["pull_request_target"]);
  assert.deepEqual(workflow.on.pull_request_target.branches, ["main"]);
  assert.deepEqual(workflow.permissions, {});

  const promotion = job(workflow, "enforcement-health-promotion");
  assert.equal(promotion["runs-on"], "ubuntu-latest");
  assert.equal(promotion["timeout-minutes"], 10);
  assert.equal(Object.hasOwn(promotion, "continue-on-error"), false);
  assert.deepEqual(promotion.permissions, { contents: "read", actions: "read" });

  const body = (promotion.steps ?? []).map((step) => `${step.uses ?? ""}\n${step.run ?? ""}`).join("\n");
  assert.match(body, /enforcement_health_promotion_cli\.ts/);
  assert.doesNotMatch(body, /probe-v54-enforcement-health\.mjs/);
  assert.doesNotMatch(body, /releases\/download\/v5\.4\.0/);
  assert.doesNotMatch(body, /setup-node-harness/);
  assert.doesNotMatch(body, /cache:/);
  assert.match(body, /npm ci --ignore-scripts/);
  assert.match(body, /npx --no-install tsx/);
});

test("promotion fetches PR objects without materializing a PR working tree", () => {
  const promotion = job(loadPromotionWorkflow(), "enforcement-health-promotion");
  const steps = promotion.steps ?? [];
  const checkouts = steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 1);

  const trusted = checkouts[0];
  assert.equal(trusted.with?.ref, "${{ github.event.pull_request.base.sha }}");
  assert.equal(trusted.with?.["persist-credentials"], false);

  for (const step of steps) {
    assert.doesNotMatch(String(step["working-directory"] ?? ""), /pr-data/);
  }
  const body = steps.map((step) => String(step.run ?? "")).join("\n");
  assert.match(body, /refs\/pull\/\$\{PR_NUMBER\}\/head/);
  assert.match(body, /--filter=blob:none/);
  assert.match(body, /--depth=256/);
  assert.match(body, /git rev-parse refs\/remotes\/pull\/head/);
  assert.match(body, /MAX_HEAD_MATRIX_BYTES=1048576/);
  assert.match(body, /git cat-file -t/);
  assert.match(body, /git cat-file -s/);
  assert.match(body, /git show/);
  assert.match(body, /--repo-root \.\.$/m);
  assert.doesNotMatch(body, /pr-data|allow-unsafe-pr-checkout/);
  assert.doesNotMatch(body, /git (?:checkout|switch|worktree|reset|restore)\b/);
  assert.doesNotMatch(readFileSync(PROMOTION_WORKFLOW, "utf8"), /\bsecrets\b/);
});
