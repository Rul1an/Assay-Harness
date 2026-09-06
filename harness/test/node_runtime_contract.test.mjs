import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { load } from 'js-yaml';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const yaml = (path) => load(read(path));
const setupSteps = (steps) => steps.filter((step) => step.uses?.startsWith('actions/setup-node@'));
const compositePath = '.github/actions/setup-node-harness/action.yml';

// These checks inspect the effective action inputs; they do not run setup-node or prove an
// installed runtime. In particular, engines is a support range, not the CI version selector.
test('package and root lock declare the same Node support floor', () => {
  const pkg = JSON.parse(read('harness/package.json'));
  const lock = JSON.parse(read('harness/package-lock.json'));
  assert.equal(pkg.engines?.node, '>=22');
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
});

test('the canonical CI version file selects major 22', () => {
  assert.ok(existsSync(new URL('.node-version', root)), 'missing canonical CI version file');
  assert.equal(read('.node-version').trim(), '22');
});

test('shared setup preserves optional override and falls back to the canonical file', () => {
  const action = yaml(compositePath);
  assert.equal(action.inputs['node-version'].required, false);
  assert.equal(action.inputs['node-version'].default ?? '', '');
  const steps = setupSteps(action.runs.steps);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].with['node-version'], '${{ inputs.node-version }}');
  assert.equal(steps[0].with['node-version-file'], '.node-version');
});

test('all direct workflow selectors use the canonical file and shared callers inherit it', () => {
  const direct = [];
  let shared = 0;
  for (const name of readdirSync(new URL('.github/workflows/', root))) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = yaml(`.github/workflows/${name}`);
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/setup-node@')) {
          direct.push(`${name}:${jobName}`);
          assert.equal(step.with?.['node-version'], undefined, `${name}:${jobName} overrides the canonical file`);
          assert.equal(step.with?.['node-version-file'], '.node-version', `${name}:${jobName} bypasses the canonical file`);
        }
        if (step.uses?.endsWith('/.github/actions/setup-node-harness')) {
          shared++;
          assert.equal(step.with?.['node-version'], undefined, `${name}:${jobName} overrides the shared default`);
        }
      }
    }
  }
  assert.deepEqual(direct.sort(), [
    'enforcement-health-promotion.yml:enforcement-health-promotion',
    'release.yml:release', 'release.yml:test', 'sbom.yml:sbom',
  ]);
  assert.ok(shared > 0, 'main CI must consume the shared selector');
});

test('promotion reads the runtime selector from the trusted base checkout', () => {
  const job = yaml('.github/workflows/enforcement-health-promotion.yml').jobs['enforcement-health-promotion'];
  const setupIndex = job.steps.findIndex((s) => s.uses?.startsWith('actions/setup-node@'));
  const checkouts = job.steps.slice(0, setupIndex).filter((s) => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(job.steps[setupIndex].with['node-version-file'], '.node-version');
});
