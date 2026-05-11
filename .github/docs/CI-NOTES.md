# CI notes

This file documents what was investigated for CI efficiency in the audit's PR5
slice, and what was deliberately not changed. It exists so a future reviewer
asking *"why is `npm ci` still running six times?"* gets the answer here, not
in folklore.

## Status snapshot (PR5)

| Surface | Change |
|---|---|
| Setup boilerplate | Consolidated into `.github/actions/setup-node-harness` composite action |
| `npm ci` calls | Still 6 — see below |
| Job count | Unchanged (9 in `harness-ci.yml`) |
| `node_modules` cache | Not added — see below |
| Wall-clock CI duration | No structural change claimed; composite action is a DRY win, not a perf win |

## What changed in PR5

**Composite action `setup-node-harness`** combines the three repeated steps
that every Node-flavoured job had: `actions/setup-node@v6` with the npm
cache, the `Install dependencies` step running `npm ci` in `harness/`. The
caller still does its own `actions/checkout` (a local composite action is
only resolvable after the repo has been checked out, so the caller must
perform that step itself) and applies its own `persist-credentials: false`
per the workflow-security baseline.

Net effect:

- 6 jobs in `harness-ci.yml` now invoke the composite instead of inlining
  the three steps.
- ~48 lines of duplicated YAML removed.
- No behaviour change: same Node version, same cache, same install command,
  same working directory.

`release.yml` and `sbom.yml` still inline `actions/setup-node@v6` because
their setup shapes diverge slightly (no `npm ci` afterwards, or release-only
context). Consolidating those was not worth the asymmetry.

### Release workflow does not use the npm cache

`release.yml` deliberately drops `cache: npm` from both its `setup-node`
steps. Two reasons:

1. **Cache hit-rate is near-zero by construction.** A release workflow
   runs once per tag push. The previous run was on a different tag —
   often weeks earlier — and the cache key (derived from the lockfile)
   may already have rotated.
2. **Supply-chain surface.** The `actions/cache` substrate is itself a
   target: cache-poisoning research has shown an attacker who can land
   a poisoned cache entry under a key the release workflow loads could
   substitute dependency tarballs at release time. For a workflow that
   produces signed release artifacts and writes attestations, the
   minute saved per release is not worth the extra trust dependency.

`harness-ci.yml` keeps `cache: npm` via the composite action because it
runs on every PR (high cache hit-rate, low integrity stakes — pre-merge
artifacts are not signed/published).

## What was investigated and not done

### 1. Job consolidation

**Considered:** merging `node-tests` + `verify-evidence` + `regression-gate`
into one job to avoid setup repetition.

**Not done because:** they currently run in parallel after
`contract-validation` finishes. Consolidating them would serialise three
parallel runners. Even with `npm ci` taking ~10–30 s, the parallel total is
faster than a serial single-job. The audit guidance was explicit:
*"alleen kleine consolidatie als de wall-clock echt daalt."*

Revisit only if a future CI bill or queue-latency problem makes parallelism
costly.

### 2. `node_modules` caching across jobs

**Considered:** caching the built `node_modules/` directory between jobs to
skip `npm ci` after the first job.

**Not done because:** the npm community broadly recommends caching the npm
download (which `setup-node@v6 cache: npm` already does) and re-running
`npm ci` per job, rather than caching `node_modules` directly. The
`node_modules` cache key is brittle (depends on platform, npm version,
lockfile, optionalDependencies). When it breaks, it breaks silently and
each job sees a different module graph. Tooling like `pnpm` solves this
better, but switching package manager is outside the audit's scope.

### 3. Path-filtered job skipping

**Considered:** skipping Python tests when only `harness/src/*.ts` changes,
and vice versa, via `paths` filters on `pull_request`.

**Not done because:** the contract tests deliberately cross the language
boundary — a TS-only change in `harness/src/evidence.ts` is the very thing
the Python contract tests should re-check. Skipping based on path would
hide that signal. The audit guidance was:
*"Houd Node/Python contract-lanes gescheiden als dat reviewbaarheid verhoogt."*

### 4. Bigger runners or self-hosted runners

**Considered:** `runs-on: ubuntu-latest-4-cores` or self-hosted.

**Not done because:** no measurement currently shows runner-CPU as the
bottleneck. The CI durations on `harness-ci.yml` jobs are in the 1–3 minute
range, dominated by `npm ci` and test execution, neither of which speeds up
linearly with more cores. Bigger runners cost more without proportional
gain at this size.

## When to revisit

This work is deferred, not closed. Revisit if:

- Total CI wall-clock on a PR consistently exceeds 10 minutes.
- A single job exceeds 5 minutes in steady state.
- Cost telemetry shows CI minutes are a top-3 expense.
- The `harness/` Node project moves to `pnpm` (then `node_modules` caching
  becomes safe via `pnpm store`).
- A new job is added that duplicates more than one of the existing setup
  shapes; the composite action should grow rather than the inline shape.

## What CI duration looked like at PR5 time

This will be filled in after PR5 merges and the new composite action runs
on `main` for at least one PR. Until then, the "no perf claim" statement
above stands on its own.

Reviewer note: if you're reading this *after* PR5 has been merged and a
duration row isn't here yet, that's a documentation debt — please open an
issue rather than re-investigating the same options.
