# Runtime Drift Tier-4 Deferral Rationale

> Why Assay-Harness does not (yet) consume
> `assay.runner.runtime_drift.v0.2` and its sub-schemas, even though
> they have published schema sidecars and committed evidence in
> [`Rul1an/assay`](https://github.com/Rul1an/assay).
>
> Last updated: 2026-05-26.

## Context

In May 2026 the `Rul1an/assay` experiments dir grew a second
cross-runtime artifact alongside the existing
`assay.runner.cross_runtime_diff.v0` (which Harness already consumes
as Tier 3):

| Artifact | Schema | Lives in | Purpose |
|---|---|---|---|
| Cross-runtime diff | `assay.runner.cross_runtime_diff.v0` (clean) | Runner-side projector | Capability-surface diff between two runtimes, gateable. |
| Runtime drift report | `assay.runner.runtime_drift.v0.2` | Experiment-side comparator (`docs/experiments/cross-runtime-drift-2026-05/compare/drift.py`) | Projection-aware drift report with path / network projection, taxonomy, provenance. Descriptive. |

Both formally have schema sidecars under
`docs/reference/runner/schema/` in `Rul1an/assay`. Both have committed
evidence: cross-runtime diff via Runner-side test fixtures; runtime
drift via Slice 3 baseline reports under `runs/drift/`.

The naive expectation was: Harness consumes both. The deliberate
decision is: Harness consumes Tier 3, not Tier 4.

## Why

### Tier 3 already covers the gating signal

The cross-runtime regression policy that Harness needs is "an arm
added a capability surface entry that the other arm did not have." The
v0 clean cross-runtime diff already encodes that signal cleanly:
`gate` returns exit 6 on any added entry across five categories,
exit 0 otherwise. That covers the CI use case end-to-end.

A second consumer for the runtime drift report would either:

- duplicate the same regression signal (no new CI value), or
- introduce a *different* regression signal that Harness would have to
  define semantics for — exactly the consumer-not-owner stance we have
  refused for Tier 3B and would refuse here too.

### Runtime drift's `non_claims` explicitly disclaim a gate

The
[`runtime-drift-v0.md`](https://github.com/Rul1an/assay/blob/main/docs/reference/runner/runtime-drift-v0.md)
contract names *"the report does not decide whether drift is
acceptable"* as one of the seven contract principles and lists
`projection_no_policy_acceptability_verdict` in
`PROJECTION_NON_CLAIMS`.

Building a Harness gate on top of a report that explicitly disclaims a
policy verdict means Harness would have to invent the verdict policy.
That collapses the consumer-not-owner boundary the Tier 3 design
relied on.

### A reviewer projection adds little over the report's own markdown

The runtime drift comparator already emits a markdown rendering
(`drift_pair_<i>.md`) with the dimension table, classification, and
projection details. A Harness `runner drift report` verb that
re-projected the JSON into markdown would be a parallel renderer with
the same output shape — not a CI artifact, not a SARIF translation,
not a new view.

The valuable Harness contributions to a JSON report are:

1. Strict v0 schema validation (catches contract drift in CI)
2. Gate translation (exit code routing)
3. CI-native projections (JUnit, SARIF)

Of those three, only (1) would apply to runtime drift today. The
existing real-archive smoke test in [`runner_archive_real_fixture.test.mjs`](../harness/test/runner_archive_real_fixture.test.mjs)
already covers schema drift for the Runner archive shape; a similar
Tier-4 smoke against a committed `drift_pair_*.json` would do the same
for the drift report. That is a low-value-per-surface-area trade —
worth keeping as a possible polish PR, not worth a Tier 4 with full
consumer infrastructure.

### Upstream is still moving

Between 2026-05-23 and 2026-05-26, the runtime drift contract moved
through `v0` → `v0.2` (PR #1377) and the comparator went through
several re-renders (PRs [#1361](https://github.com/Rul1an/assay/pull/1361),
[#1365](https://github.com/Rul1an/assay/pull/1365),
[#1366](https://github.com/Rul1an/assay/pull/1366),
[#1367](https://github.com/Rul1an/assay/pull/1367),
[#1368](https://github.com/Rul1an/assay/pull/1368),
[#1370](https://github.com/Rul1an/assay/pull/1370),
[#1377](https://github.com/Rul1an/assay/pull/1377)).

`cross_runtime_diff.v0` has been stable since v0.6.0 landed. Building
Tier 4 against a contract that is still iterating means chasing the
schema string with each upstream revision.

## When to revisit

Open this back up if any of the following happen:

1. A CI-blocking semantic emerges from runtime drift that
   `cross_runtime_diff.v0` cannot express (e.g. policy-acceptability
   verdict gets defined on the Runner side and becomes part of the
   schema, not a non-claim).
2. A real consumer (a downstream Trust Basis claim family, an SDK
   reviewer, a release pipeline) asks for the drift report shape in a
   way that the existing markdown rendering does not satisfy.
3. The Runner-side contract stops moving for one minor release cycle
   (so a Tier-4 consumer would not be chasing).
4. The Runner side decides to promote runtime drift from the
   experiment dir to the canonical reference schema set (move from
   `docs/experiments/` to a `crates/assay-runner-*/` shipped output
   path, with its own release-binary proof).

Until one of those four happens, this stays parked.

## What we do consume from the drift ecosystem

- **Nothing directly from `runtime_drift.v0.2`** today.
- The sub-schemas (`path_projection.v0`, `network_projection.v0`,
  `runtime_noise_taxonomy.v0`, `drift_report_provenance.v0`,
  `projection_not_applied.v0`) are all defined inside `runtime_drift`
  and inherit the same deferral.

## Non-deferred follow-ups

The deferral does not affect:

- The Tier 1 real-archive smoke fixture from
  [`Rul1an/Assay-Harness#65`](https://github.com/Rul1an/Assay-Harness/issues/65),
  which uses a Slice 3 archive captured under the same
  `assay-bpf-runner` infrastructure that produces the runtime drift
  comparator's input. Tier 1 owns archive recognition; runtime drift
  is downstream of Tier 1, not parallel to it.
- The optional `access_mode`-aware kernel-layer projection (v0.7
  candidate) which sits on `assay.runner.kernel_event.v0` and is a
  Tier 2B UX refinement, unrelated to the drift report.
- The cross-repo boundary doc
  [`RUNNER_SCHEMA_CONSUMPTION.md`](RUNNER_SCHEMA_CONSUMPTION.md) which
  records the deferral alongside everything Harness consumes.

## Cross-references

- Runner-side contract doc:
  [`docs/reference/runner/runtime-drift-v0.md`](https://github.com/Rul1an/assay/blob/main/docs/reference/runner/runtime-drift-v0.md)
- Runner-side schema sidecar:
  [`docs/reference/runner/schema/runtime-drift-v0.2.schema.json`](https://github.com/Rul1an/assay/blob/main/docs/reference/runner/schema/runtime-drift-v0.2.schema.json)
- Harness consumption inventory:
  [`RUNNER_SCHEMA_CONSUMPTION.md`](RUNNER_SCHEMA_CONSUMPTION.md)
