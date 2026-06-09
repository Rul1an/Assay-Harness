# Runner Schema Consumption

> Cross-repo boundary doc. Lists which Runner-side schemas from
> [`Rul1an/assay`](https://github.com/Rul1an/assay) Assay-Harness
> consumes, which it ignores, and what is still open.
>
> Companion to
> [`Rul1an/assay docs/reference/runner/schemas-overview.md`](https://github.com/Rul1an/assay/blob/main/docs/reference/runner/schemas-overview.md),
> which is the canonical Runner-side inventory.
>
> Last updated: 2026-06-09.

## What Assay-Harness consumes

| Schema | Tier | Since | Harness module |
|---|---|---|---|
| `assay.runner.archive_manifest.v0` | 1 | v0.4.0 | [`runner_archive.ts`](../harness/src/runner_archive.ts) |
| `assay.runner.observation_health.v0` | 1 | v0.4.0 | [`runner_archive.ts`](../harness/src/runner_archive.ts) |
| `assay.runner.correlation_report.v0` | 1 | v0.4.0 | [`runner_archive.ts`](../harness/src/runner_archive.ts) |
| `assay.runner.capability_surface.v0` | 1 + 2A | v0.4.0 | [`runner_archive.ts`](../harness/src/runner_archive.ts) + [`runner_compare.ts`](../harness/src/runner_compare.ts) |
| `assay.runner.sdk_event.v0` | 2B | v0.5.0 | [`runner_layers.ts`](../harness/src/runner_layers.ts) |
| `assay.runner.cross_runtime_diff.v0` (clean shape) | 3A + 3C | v0.6.0 | [`runner_cross_runtime.ts`](../harness/src/runner_cross_runtime.ts) |

Each consumed schema has a corresponding `RUNNER_*_SCHEMA` constant in
the Harness sources. Smoke coverage against a real Runner-produced
`.tar.gz` lives in
[`harness/test/runner_archive_real_fixture.test.mjs`](../harness/test/runner_archive_real_fixture.test.mjs)
with provenance in
[`harness/fixtures/runner/PROVENANCE.md`](../harness/fixtures/runner/PROVENANCE.md).

## What Assay-Harness sees but does not consume

| Schema | Source | Why ignored (today) |
|---|---|---|
| `assay.runner.kernel_event.v0` (line schema) | [`Rul1an/assay#1362`](https://github.com/Rul1an/assay/pull/1362) + [`#1363`](https://github.com/Rul1an/assay/pull/1363) | Tier 2B reads `layers/kernel.ndjson` for the count + event_type histogram view only. Optional open metadata (`access_mode`, `operation_flags`, `status`, `return_value`) is present in newer archives but ignored. Reading them would be a reviewer-UX upgrade (read / write / create / truncate / append) with no new gating semantics; tracked as a v0.7 candidate in [`ROADMAP.md`](ROADMAP.md). |

## What Assay-Harness deliberately does not consume

| Schema | Source | Reason |
|---|---|---|
| `assay.runner.runtime_drift.v0` / `v0.2` | [`Rul1an/assay#1361`](https://github.com/Rul1an/assay/pull/1361) / [`#1377`](https://github.com/Rul1an/assay/pull/1377) | The runtime drift comparator is the experiment-side projection-aware report. Its `non_claims` explicitly say *"not a policy verdict."* Harness already has a cross-runtime gate (Tier 3) for the canonical `cross_runtime_diff.v0` artifact. Adding a second cross-runtime consumer without a distinct gate semantic would double the surface without adding a CI signal. See [`RUNTIME_DRIFT_DEFERRAL.md`](RUNTIME_DRIFT_DEFERRAL.md) for the full rationale. |
| `assay.runner.path_projection.v0` | embedded in `runtime_drift` | Sub-schema inside `runtime_drift`; sees the same deferral. |
| `assay.runner.network_projection.v0` | embedded in `runtime_drift` | Sub-schema inside `runtime_drift`; sees the same deferral. |
| `assay.runner.runtime_noise_taxonomy.v0` | embedded in `runtime_drift` | Sub-schema inside `runtime_drift`; sees the same deferral. |
| `assay.runner.drift_report_provenance.v0` | embedded in `runtime_drift` | Sub-schema inside `runtime_drift`; sees the same deferral. |
| `assay.runner.projection_not_applied.v0` | embedded in `runtime_drift` | Sub-schema inside `runtime_drift`; sees the same deferral. |
| `assay.experiment.overhead_sample.v0` / `overhead_summary.v0` | [`Rul1an/assay#1378`](https://github.com/Rul1an/assay/pull/1378) + [`#1379`](https://github.com/Rul1an/assay/pull/1379) | Experiment-scoped namespace explicitly *"not a Runner archive contract and not promoted to stable product surface"* per the Runner-side schemas-overview. Harness ignores the `assay.experiment.*` namespace by policy — it is reserved for time-limited measurement evidence, not stable artifacts. |
| `assay.enforcement_health.v0` | [`Rul1an/assay#1574`](https://github.com/Rul1an/assay/pull/1574) (assay v3.20.0) | Enforcement-truth carrier in the top-level `assay.*` namespace, deliberately separate from the `assay.runner.*` archive the Harness reads, so it is not present in the runner `.tar.gz` at all. It records whether enforcement (e.g. IPv4/TCP connect egress) was actually active and blocked (`active` / `absent` / `failed` / `not_applicable`), which is a different question from how complete the observation was. The Harness reports observed coverage from `observation_health` and must never let observed coverage be read as enforcement; the consumer of enforcement truth is Plimsoll, which reads the artifact via `--enforcement-health` and surfaces it under a dedicated `enforcement` block. Keeping it out of the Harness preserves the separation: `observation_health` = observation completeness, `enforcement_health` = enforcement outcome, neither inferred from the other. |

**Principle:** observation and coverage reports must not imply enforcement unless an
`enforcement_health` artifact is explicitly provided by a consumer layer.

## Cross-repo boundary

The Runner side ([`Rul1an/assay`](https://github.com/Rul1an/assay))
**owns** every `assay.runner.*.v0` schema. Schema changes start there;
Harness chases.

Assay-Harness is **consumer**, not semantic owner. This boundary holds
for every Tier:

- **Tier 1 (archive recognition)**: Harness reads file contents and
  validates digests; the Runner side defines what a manifest means.
- **Tier 2A (capability-surface diff)**: Harness computes set diffs on
  capability arrays; the Runner side defines what each category means.
- **Tier 2B (per-layer projection)**: Harness summarises layer ndjson
  streams; the Runner side defines event-shape schemas.
- **Tier 3 (cross-runtime diff)**: Harness validates the
  `cross_runtime_diff.v0` clean shape and translates the regression
  signal into a CI exit code; the Runner side defines A1+B3+C1
  canonicalisation, out-of-scope markers, and SDK-metadata side-band
  semantics.

This is the discipline that keeps the two repos honest: Runner-side
contracts can move (within v0 stability), and Harness chases via
schema-string constants and explicit TypeScript guards rather than
re-implementing the semantics.

## Versioning convention parity

Both repos follow the same dotted-namespace pattern:
`<owner>.<system>.<artifact>.<version>`.

| Owner / namespace | Stability promise |
|---|---|
| `assay.runner.*` | v0 contract surface; minor refinements within v0 are common, breaking changes require an explicit v1 |
| `assay.experiment.*` | experiment-scoped, time-limited, not promoted to stable surface (Harness ignores by policy) |
| `assay.trust-basis.*` | Assay-core contract surface; see [`ASSAY_COMPATIBILITY.md`](ASSAY_COMPATIBILITY.md) |
| `assay.enforcement_health.*` | Enforcement-truth carrier, producer-agnostic, outside the `assay.runner.*` archive (Harness does not consume; Plimsoll does) |
| `assay.harness.*` | Harness-internal envelope (NDJSON evidence shape); Runner side does not consume |

The Runner side started introducing `vX.Y` dotted-minor versions in
2026-05 (e.g. `assay.runner.runtime_drift.v0.2`). Harness currently
pins to bare-v0 strings for everything it consumes; a dotted-minor
schema string would require explicit pattern handling in the
`RUNNER_*_SCHEMA` constants. None of the consumed schemas have moved
to dotted-minor yet, so this is a forward-compat concern, not a
current bug.

## Refresh policy

Refresh this doc when:

1. A new `assay.runner.*` schema is published Runner-side and Harness
   needs to decide consume / ignore / defer.
2. A Tier moves between states (e.g. Tier 3B parked → planned).
3. The cross-repo boundary changes (e.g. Runner side starts shipping
   binaries instead of TypeScript fixtures).

Routine schema patch versions in `Rul1an/assay` (typo fixes, comment
updates, etc.) do not require an entry here.
