# Changelog

All notable changes to Assay Harness will be documented in this file.

## [Unreleased]

### Assay-Runner cross-runtime diff consumer + gate (Tier 3A + Tier 3C)

Adds two new CLI verbs for reading and gating on a precomputed
`assay.runner.cross_runtime_diff.v0` JSON artefact (produced Runner-side in
`Rul1an/assay`). Both verbs reuse the same strict v0 clean-schema validator:

- `assay-harness runner cross-runtime report --diff <path> [--format markdown|json]`
  — reviewer projection of the diff. Informational only; exits 0 on a
  valid diff regardless of whether it contains a regression, exits 3 on a
  contract-shape violation.
- `assay-harness runner cross-runtime gate --diff <path>`
  — CI-blocking translation of the same signal. Exits 0 on a clean diff,
  6 on any added capability surface, 3 on contract-shape violation. No
  new semantic logic vs `report`; only exit translation. Stdout stays
  clean; status line goes to stderr for CI logs.

Tier 3A + 3C are **consumer**, not semantic owner. The Runner side defines
the cross-runtime semantics (A1+B3+C1 canonicalisation, out-of-scope
markers for binding ids and policy outcomes, SDK metadata as side-band
provenance). Harness validates the frozen contract shape and translates
the regression signal into reviewer output and CI exit codes.

- New module `harness/src/runner_cross_runtime.ts`:
  - Schema constants pinned to the Runner-side v0 contract
    (`RUNNER_CROSS_RUNTIME_DIFF_SCHEMA`,
    `RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER`,
    `RUNNER_CROSS_RUNTIME_SDK_METADATA_MARKER`,
    `RUNNER_CROSS_RUNTIME_RUNTIMES`,
    `RUNNER_CROSS_RUNTIME_REQUIRED_NON_CLAIMS`,
    `RUNNER_CROSS_RUNTIME_REQUIRED_NOTES`).
  - Strict v0 clean-schema validation: `status === "clean"`, runtime
    identifiers from the v0 enum and distinct, `preconditions.*` all
    `true`, exact const values on `scope` and `canonicalization` (A1
    work-dir-prefix rule on filesystem_paths, `"none"` elsewhere),
    `unbound.*` arrays empty, `ambiguities: []`, `non_claims` and
    `notes` matching the 5-string and 3-string fixed prefixes in
    order. Tampered out-of-scope markers fail with distinct error
    codes. Surface category arrays have `uniqueItems` enforcement.
  - No JSON Schema 2020-12 validation library is added; explicit
    TypeScript guards keep the runtime dependency surface flat.
- Two new CLI verbs (`report`, `gate`) dispatched via a new
  `args._subfile` slot in `parseArgs` so three-level positional verbs
  (`runner cross-runtime report` and `runner cross-runtime gate`) work
  without breaking existing two-level verbs.
- Exit-code routing:
  - **report**: contract-shape valid → 0 (informational; regression
    rendered in the report but does not affect exit code); contract
    violation → 3; missing `--diff` or file → 2.
  - **gate**: clean diff → 0; any added entry in
    `surface.{filesystem_paths,network_endpoints,process_execs,
    mcp_tools,policy_decisions}` → 6; contract violation → 3; missing
    `--diff` or file → 2.
- v0 cross-runtime regression policy mirrored from the Runner-side
  schema and from within-runtime Tier-2A: added entries on any of the
  five categories trigger the regression signal. Removed entries are
  reported but never blocking. SDK metadata changes are side-band
  provenance only — `gate` exits 0 when only `sdk_metadata` differs.
- **Tier 3B** (archive-pair convenience wrapper that produces the
  diff from two raw Runner archives) remains deferred. Per
  `Rul1an/Assay-Harness#58` Tier 3 plan, 3B would either re-implement
  Runner-side A1+B3+C1 semantics or vendor the Runner-side projector;
  either keeps Harness producing cross-runtime semantics, which the
  consumer-not-owner stance refuses. 3B is parked as a future demo
  recipe, not as core CLI surface.
- New tests in `harness/test/runner_cross_runtime.test.mjs` cover the
  full strict-schema validator (schema mismatch, non-object payload,
  missing categories, non-array added field, tampered markers,
  status != clean, unknown runtime, runtimes_not_distinct,
  preconditions false/missing, scope/canonicalization const
  mismatches, non-empty unbound, non-empty ambiguities,
  non_claims/notes wrong/missing/out-of-order, surface duplicates),
  the `report` markdown formatter discipline (status label matches
  outcome class, SDK metadata side-band caveat, removed-not-blocking,
  `unchanged` omitted), and the full `gate` exit-routing matrix
  (clean=0, added-fs/net=6, removed-only=0, sdk-only=0, invalid=3,
  bare --diff=2, missing file=2, stdout-stays-clean).
- No new npm dependency. No new contract. NDJSON callers and Tier 1 /
  Tier 2A / Tier 2B paths are unchanged.

## [0.5.0] - 2026-05-23

This minor release adds opt-in support for **Assay-Runner measured-run
archives** as an input shape for Assay-Harness, alongside the existing
NDJSON evidence path. It introduces two new CLI verbs (`verify-runner`
and `runner compare`), a Tier-2A capability-surface regression diff, and
a Tier-2B per-layer reviewer projection.

> Assay-Runner remains internal to `Rul1an/assay`; this is not a
> standalone Runner release. The Runner v0 contracts referenced here
> (archive manifest, observation-health, correlation-report,
> capability-surface, sdk-event) are immutable Runner-side artefacts.
> Cross-runtime diff consumption is deferred (Tier 2C / future option).

The version bump from `0.4.0` to `0.5.0` is a minor bump because:

- new CLI surface (`verify-runner`, `runner compare`)
- new optional input shape (Runner archives) routed through extension-based
  mode detection
- existing NDJSON callers and existing exit-code contract are unchanged
- no breaking change to any prior 0.4.x flow

### Docs: positioning of Assay-Runner archives as an optional input shape

Adds one short README section under "What this is not" describing that
Assay-Harness can also validate and compare Assay-Runner measured-run
archives as an opt-in input shape, with a pointer to
`docs/contracts/EXIT_CODES.md` for the per-command exit-code routing.
Explicit about non-claims:

- Runner archives are defined and produced by the Runner side of
  `Rul1an/assay`; they are an **internal** measured-run subsystem of
  Assay, not a standalone product
- Cross-runtime diff consumption is deferred (future option, not
  currently implemented)
- NDJSON evidence callers are unaffected
- No new CLI surface, no new exit codes, no release commitment, no
  badges, no marketing language

Closes Tier-2A/2B positioning (H7) in `Rul1an/Assay-Harness#58`.

### Assay-Runner per-layer reviewer projection (Tier 2B)

Adds an explanatory per-layer reviewer projection to
`assay-harness runner compare`. Tier 2B sits alongside the Tier-2A
capability-surface diff in the same output; it is **explanatory only**,
does not change the Tier-2A regression flag, does not add new exit codes,
and does not introduce new gating semantics. The goal is reviewer UX —
help a reviewer see *where* a Tier-2A surface diff came from, without
inventing new contract semantics on the Harness side.

- New module `harness/src/runner_layers.ts`:
  - Parses each archive's `layers/{kernel,policy,sdk}.ndjson` streams
    (ndjson lines that fail JSON parse are counted, not thrown — the
    projection is supplementary and must not block on upstream emitter
    issues).
  - Summarises each layer with total event count, event-type histogram
    (grouped by `event_type` with fallback to `type`), and — for the
    SDK layer only — a deduped set of distinct `tool` values. Kernel and
    policy layers stay at the conservative count + event-type-histogram
    view because no Harness-side v0 event-shape contract exists for them.
  - Diffs the per-side summaries across baseline and candidate at the
    event-type-histogram level, plus a set-diff of SDK tool names.
  - Carries the `sdk_layer_is_self_reported_per_v0_contract` caveat into
    the SDK summary and diff so any consumer surfaces it without having
    to re-read the v0 contract.
- `harness/src/runner_archive.ts`: exports a public
  `readRunnerArchiveFiles(filePath)` so Tier 2B can share the same
  size-limited gunzip + tar reader as Tier 1 without duplicating the
  pipeline.
- `harness/src/runner_compare.ts`: `RunnerCompareResult` gains an
  optional `layer_projection` field. It is populated when both archives
  are Tier-1 clean and Tier 2A could compute a capability-surface diff;
  it stays `undefined` when Tier 1 fails or the archive cannot be
  re-read. The Tier-2A regression flag is unchanged by Tier 2B values.
- Markdown formatter (`formatRunnerCompareResult`) now appends a
  `## Per-Layer Projection (Tier 2B — reviewer UX, not a gate)` section
  below the Tier-2A diff and regression-reasons sections when a
  projection is available. JSON output exposes `layer_projection` for
  machine consumers.
- New tests in `harness/test/runner_layers.test.mjs` cover per-layer
  counts and event-type histogram diffing, the SDK self-reported caveat,
  unparseable-ndjson handling, missing-layer notes, Tier-2A regression
  flag independence from Tier 2B values, markdown discipline including
  the projection's position below the Tier-2A diff, and `undefined`
  behaviour when Tier 1 fails.
- No new npm dependency. No new exit codes. No new contract.

### Assay-Runner capability-surface diff (Tier 2A)

Adds `assay-harness runner compare` for diffing two Tier-1-clean Assay-Runner
measured-run archives on their `assay.runner.capability_surface.v0` payload.
Tier-2A scope only: archive-only diff using existing v0 artifact semantics, no
new runtime interpretation, no layer-ndjson consumption, no cross-runtime
diff. Tier 2B (per-layer reviewer projection) and Tier 2C (cross-runtime
consumer) remain open in `Rul1an/Assay-Harness#58`.

- New CLI verb:
  `assay-harness runner compare --baseline <archive.tar.gz>
   --candidate <archive.tar.gz> [--format markdown|json] [--allow-degraded]`.
- Prerequisite: both archives must pass Tier 1 (recognised, manifest valid,
  honest-health clean — `kernel_layer=complete`, `ringbuf_drops=0`,
  `cgroup_correlation=clean`, `correlation_report.status=clean`,
  archive manifest schema valid). If either side fails, Tier 2 is **not
  computed**; the result reports `tier1_validation_failed` with the per-side
  Tier-1 reasons and exits `artifact_contract` (3).
- Diff covers the five v0 set categories: `filesystem_paths`,
  `network_endpoints`, `process_execs`, `mcp_tools`, `policy_decisions`.
  Each category yields `added`, `removed`, and `unchanged` lists in JSON;
  markdown output shows `added` and `removed` only.
- v0 regression policy:
  - added `filesystem_paths`, `network_endpoints`, `process_execs`,
    `mcp_tools` → regression
  - added `policy_decisions` of the form `allow:*` → regression
  - added `policy_decisions` of the form `deny:*` → **report-only** (the
    diff still records the addition; the regression flag does not trip,
    because new deny decisions typically reflect newly visible blocked
    behaviour rather than added capability surface)
  - removed entries → reported, never a regression
- Exit codes (strict Tier-2 verb semantics; any Tier-1-not-clean input is
  an `artifact_contract` failure, not a regression):
  - clean → `success` (0)
  - capability-surface regression → `regression` (6)
  - any Tier-1 fail on either side (invalid archive, manifest/digest
    invalid, honest-health degraded, observation-health /
    correlation-report missing or malformed, `capability-surface.json`
    missing or shape-invalid) → `artifact_contract` (3)
  - extension-based input is not a `.tar.gz` / `.tgz` on either side →
    `config_error` (2). `cmdRunnerCompare` calls `detectInputMode()` at
    CLI level so a stray NDJSON or `.txt` is caught early instead of
    being routed through the archive validator.
  This routing is intentionally stricter than `compare`'s Runner-mode
  routing (which exits 6 for honest-health and 6 for missing
  capability-surface). The `runner compare` verb is explicitly the
  Tier-2 diff path; if Tier 1 is not clean, the precondition is not met
  and there is no Tier-2 result to report.
- Runtime shape guard for `capability-surface.json`. The validator now
  rejects payloads where any of `filesystem_paths`, `network_endpoints`,
  `process_execs`, `mcp_tools`, or `policy_decisions` is missing, not
  an array, or contains non-string elements
  (`CAPABILITY_SURFACE_SHAPE_INVALID`). Pre-fix a malformed but
  schema-matching payload could crash the Tier-2A differ when it called
  `Array.prototype.filter` on a non-array.
- New module `harness/src/runner_compare.ts` for the diff and formatter.
  `validateRunnerArchive` in `runner_archive.ts` extended to parse
  `capability-surface.json` into the optional `capability_surface` field on
  `RunnerArchiveValidation` (additive; no breaking change).
- New tests in `harness/test/runner_compare.test.mjs` cover the regression
  policy, the deny-vs-allow split for policy decisions, removed-not-blocking
  semantics, Tier-1-skip behaviour, the missing-capability-surface path, and
  the markdown formatter's omit-unchanged rule.

This does NOT change `assay-harness compare` behaviour for either NDJSON or
Runner-archive inputs; the existing Tier-1 path is unchanged. `runner compare`
is a separate, explicit verb for the Runner-aware regression-diff use case.


### Assay-Runner archive recognition (Tier 1)

Adds Tier-1 support for reading Assay-Runner measured-run archives in
`assay-harness compare` and a dedicated `assay-harness verify-runner`
command. Tier-1 scope is **recognition + validation + honest-health gate
only**; structural diff across two Runner archives is Tier 2 and is not
implemented in this version. See `Rul1an/Assay-Harness#58`.

- New module `harness/src/runner_archive.ts` with:
  - Schema-string constants pinned to `Rul1an/assay@cd242666`
    (`assay.runner.archive_manifest.v0`,
    `assay.runner.observation_health.v0`,
    `assay.runner.correlation_report.v0`)
  - `detectInputMode(path)` (H6): classify a file purely by extension as
    `ndjson_evidence`, `runner_archive`, or `unknown`. Content validation
    is left to `validateRunnerArchive` so that a corrupted or non-Runner
    `.tar.gz` surfaces as `artifact_contract` (3), not `config_error` (2)
  - `validateRunnerArchive(path)` (H1): parse `.tar.gz`, verify manifest
    schema, verify every manifest entry's presence, byte count, and
    SHA-256 digest. Digests are validated in the `sha256:<64-hex>` form
    written by the Rust runner core
    (`crates/assay-runner-core/src/archive.rs::sha256_prefixed`); raw-hex
    digests are rejected as `MANIFEST_ENTRY_DIGEST_FORMAT_INVALID`. Also
    rejects archive entries not listed in `manifest.files` (except
    `manifest.json` itself, which the Rust writer does not list in its
    own files map) as `FILE_NOT_IN_MANIFEST`. Compressed and decompressed
    size are bounded
    (`RUNNER_ARCHIVE_MAX_COMPRESSED_BYTES`,
    `RUNNER_ARCHIVE_MAX_DECOMPRESSED_BYTES`) so a crafted gzip cannot
    cause unbounded memory consumption
  - The validation result separates strict H1 issues (`manifest_errors`)
    from secondary `observation-health.json` / `correlation-report.json`
    parse failures (`artifact_parse_errors`). `manifest_valid` is
    controlled by `manifest_errors` only, so a wrong observation-health
    schema string never makes the manifest itself appear invalid
  - `checkHonestHealth(validation, options)` (H2): gate on
    `kernel_layer === "complete"`, `ringbuf_drops === 0`,
    `cgroup_correlation === "clean"`, `correlation_report.status ===
    "clean"`. Failure reasons are split into
    `measurement_health_reasons` (bypassable by `allow_degraded`) and
    `structural_reasons` (archive not recognised, manifest invalid,
    observation-health or correlation-report missing or malformed —
    never bypassable). `allow_degraded` therefore cannot produce a
    state where `manifest_valid: false` co-exists with
    `honest_health.passed: true`
- `assay-harness compare` now dispatches by file extension:
  - both inputs `.ndjson` / `.jsonl`: existing comparison, unchanged
  - both inputs `.tar.gz` / `.tgz`: Tier-1 validation path
    (`compareRunnerArchivesTier1`) returning a
    `RunnerCompareTier1Result` with explicit `tier2_diff_implemented:
    false`. A corrupted or non-Runner `.tar.gz` exits with
    `artifact_contract` (3) because the validator surfaces the
    structural failure, not `config_error` (2)
  - mixed extensions or unknown extensions: clear `config_error`
- New `assay-harness verify-runner <archive.tar.gz>
  [--format markdown|json] [--allow-degraded]` for single-archive
  verification. JSON output now exposes
  `manifest_errors`, `artifact_parse_errors`,
  `honest_health.structural_reasons`, and
  `honest_health.measurement_health_reasons` separately
- Exit code routing (see `docs/contracts/EXIT_CODES.md`):
  - strict H1 failure → `artifact_contract` (3)
  - honest-health failure (whether measurement-degraded or structural,
    such as observation-health missing) without `--allow-degraded` →
    `regression` (6). `--allow-degraded` bypasses only measurement
    reasons, not structural ones
  - clean → `success` (0)
- No new npm dependency; `.tar.gz` reading uses `node:zlib` for gunzip
  and an in-file minimal ustar parser (Runner archives use deterministic
  ustar headers with short paths)
- New tests in `harness/test/runner_archive.test.mjs` covering H6
  detection (now extension-based), H1 manifest/digest validation
  including `sha256:` prefix enforcement and extra-file detection, H2
  honest-health gating including the structural / measurement-health
  reason split, and the `compareRunnerArchivesTier1` integration

This does **not** imply Assay-Harness now depends on Assay-Runner. It
adds opt-in recognition for callers that produce Runner archives. NDJSON
evidence callers are unaffected.

## [0.4.0] - 2026-05-11

This minor release rolls up two audit cycles (audit baseline `c2c869c` and
follow-up audit at `31669dc`) plus the Claude Agent SDK adapter tightening
that was previously sitting under `[Unreleased]`. Behaviour-affecting
changes are listed first; refactor and CI posture below.

The version bump from `0.3.2` to `0.4.0` is required: `PRODUCER_VERSION`
is now sourced from `package.json` (see Evidence integrity below), so every
emitted evidence event now stamps the package version. Continuing to ship
`0.3.2` would leave the version-truth test asserting against stale state.

### Evidence integrity

- Recursive forbidden-key scan in `assay-harness verify`. Previous shallow
  check only inspected keys directly under `event.data`; nested shapes
  such as `data.observed.raw_run_state` slipped through. New scan walks
  the full object graph (including array elements with bracket-index
  paths) and emits the precise dotted path in error messages.
- Two error-code classes replace the prior single `VERIFY_REJECTED_KEY`:
  - `VERIFY_FORBIDDEN_RUNTIME_KEY` — raw SDK state
    (`raw_run_state`, `history`, `newItems`, `lastResponseId`, `session`).
  - `VERIFY_FORBIDDEN_PAYLOAD_KEY` — raw payload bodies
    (`raw_arguments`, `raw_output`, `transcript`, `audio_blob`,
    `session_recording`, `request_payload`, `response_payload`,
    `raw_payload`). Keeps verifier-policy symmetric with the MCP
    hardening tests that already reject these on the way in.
- `PRODUCER_VERSION` in `harness/src/evidence.ts` is now sourced from
  `package.json` via `readFileSync` + `JSON.parse` (Node 20-compatible;
  the experimental `import ... with { type: "json" }` form was avoided).
  A regression test pins `PRODUCER_VERSION === package.json.version`,
  with semver-grammar validation that allows build metadata.
- Dropped the unused `canonicalJson` helper; `sortedStringify` is the
  live implementation.

### MCP lane

- `assay-harness mcp` now emits a real `assay.harness.mcp-interaction`
  event per tool invocation (server_ref, tool_name, decision,
  content-hashed args). The previous implementation built the artifact
  but discarded it before emission.
- `createMcpServer` validates `command` and every `args[]` element
  against a shell-metacharacter denylist before concatenating into
  `fullCommand` (OWASP MCP Top 10 — MCP05 command injection).
- New opt-in `allowUnsafeFullCommand?: boolean` on `createMcpServer`
  for legitimate paths with whitespace that the strict default
  rejects (e.g. `/Users/me/Application Support/...`). Default
  preserves the denylist. The option is named to make the risk
  visible at the call site rather than reading as a blessed mode.
- Renamed `argument_hash` → `arguments_hash` on the MCP-interaction
  event for schema consistency with the existing `ApprovalInterruption`
  shape and the `hashArguments` helper.

### Policy and Trust Basis

- Policy wildcard matcher escapes all 12 regex metacharacters before
  building the matching pattern, not just `.` and `*`. Patterns like
  `tool(name)?` no longer surprise authors by turning `?` into a
  regex quantifier.
- Policy YAML is validated against a `zod` schema at load time, with
  precise field-path errors instead of the previous shallow truthiness
  check.
- `assay-harness trust-basis gate` adds a 30 s `spawnSync` timeout
  and a 10 MiB per-stream `maxBuffer`, with explicit error
  discrimination for `ETIMEDOUT` / `SIGTERM` and
  `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.

### Claude Agent SDK adapter

- Tightened the Claude Agent SDK `can_use_tool` adapter after
  [`anthropics/claude-agent-sdk-python#844`](https://github.com/anthropics/claude-agent-sdk-python/issues/844):
  `tool_use_id` is now treated as required on that path, and missing,
  blank, or whitespace-padded values are rejected instead of replaced
  with a placeholder or rewritten audit id.

### Workflow security and release posture

- Workflow-level `permissions: {}` on all workflows, with each job
  granting only the scope it needs. SARIF-uploading jobs get
  `security-events: write`; release jobs get
  `contents: write` + `id-token: write` + `attestations: write`.
- `persist-credentials: false` on every `actions/checkout` invocation.
- Template injection fix on the `workflow_dispatch` `assay_version`
  input — now routed through env before reaching the shell.
- Release workflow uses `gh release create` (with idempotent
  fall-through to `gh release upload --clobber` on re-runs) instead
  of `softprops/action-gh-release@v3`.
- Release workflow no longer caches npm (`cache: npm` removed). For
  release workflows the cache hit-rate is near-zero by construction
  and the cache substrate adds supply-chain ambiguity at the moment
  attestations are written.
- Dependabot cooldown configured: 5-day default, 14-day major on npm.
- New `.github/workflows/zizmor.yml` canary running on PRs, push to
  main, and weekly, enforcing `--min-confidence high` with SARIF
  upload to GitHub code scanning. Trust-anchored organisations
  (`actions/*`, `github/*`, `peter-evans/*`) are accepted at
  ref-pin via `.github/zizmor.yml`; everything else falls back to
  the strict default.

### CI plumbing

- New `.github/actions/setup-node-harness` composite action wrapping
  `setup-node@v6` + `npm ci`. Six jobs in `harness-ci.yml` now invoke
  the composite, removing ~48 lines of duplicated YAML.
- `.github/docs/CI-NOTES.md` documents what was investigated and
  deliberately not changed (job consolidation, `node_modules`
  caching, path-filtered skipping, bigger runners), each with a
  "when to revisit" trigger.

### Mapper

- Documented the `PLACEHOLDER_*` constants in `mapper/map_to_assay.py`
  as intentional. The mapper produces example envelopes; the
  placeholder identity must not be silently replaced with a real
  producer version.

## [0.3.2] - 2026-04-29

This patch release records the post-Assay-`v3.9.0` compatibility proof for the
existing Assay Harness `v0.3.x` line.

### Compatibility

- Verified the existing `v0.3.1` three-family Trust Basis recipes against the
  released Assay `v3.9.0` binary in
  [`Harness CI` run 25131209377](https://github.com/Rul1an/Assay-Harness/actions/runs/25131209377).
- Updated the manual release-binary compatibility workflow default to
  `assay_version = v3.9.0`. Assay `v3.8.0` remains the minimum exact tag for
  this compatibility line.

## [0.3.1] - 2026-04-29

This compatibility release aligns Assay Harness with the Assay `v3.8.0`
release-contract line.

### Release Compatibility

- **Assay compatibility target**: docs now require Assay `>= v3.8.0` for this
  line. Harness still consumes `assay.trust-basis.diff.v1`, Trust Card schema
  v5, and the 10-claim eval / decision / inventory Trust Basis surface.
- **Real release-binary proof rail**: `Harness CI` now has a
  `workflow_dispatch` compatibility job that downloads a chosen Assay release
  binary, verifies its checksum, and runs the Promptfoo, OpenFeature, and
  CycloneDX recipes against it. At the time of the `v0.3.1` release, the
  default target was `v3.8.0`.
- **Recipe artifact preservation**: the compatibility job uploads recipe output
  roots containing raw Trust Basis diff JSON, Markdown summaries, and JUnit XML.

### Hygiene

- Promptfoo recipe output-root safety now matches the OpenFeature and CycloneDX
  recipes by refusing root, repo, harness, and home directory overwrite targets.
- README wording now separates generic evidence SARIF export from Trust Basis
  gate/report outputs. Trust Basis gate/report emits raw diff JSON, Markdown,
  and JUnit, not SARIF.
- Release docs explicitly keep this as a GitHub release / repository CLI line,
  not an npm publication claim.

## [0.3.0] - 2026-04-29

This companion release aligns Assay Harness with the released Assay `v3.7.0`
three-family evidence-portability line.

### Three-Family Trust Basis Compatibility

- **Compatibility refresh**: Trust Basis fixtures, recipe regression fixtures,
  and recipe tests target the released Assay `v3.7.0` surface:
  `assay.trust-basis.diff.v1`, Trust Card schema v5, 10 frozen claims, and the
  eval / decision / inventory receipt boundary claim families.
- **Claim-family agnostic gate/report path**: Promptfoo, OpenFeature, and
  CycloneDX recipes continue to use the same Harness Trust Basis gate/report
  layer. Harness does not add family-specific branching, report semantics, or
  gate semantics.
- **Recipe compatibility docs**: `docs/ASSAY_COMPATIBILITY.md` records Assay
  `v3.7.0` as the exact compatibility target for this release.

### Receipt Pipeline Recipes

- **Promptfoo**: recipe fixtures regress
  `external_eval_receipt_boundary_visible` for Trust Basis regression examples.
- **OpenFeature**: the decision receipt pipeline remains boolean
  `EvaluationDetails` only and now aligns with the decision receipt boundary
  claim.
- **CycloneDX ML-BOM**: the model-component receipt pipeline remains one
  selected `machine-learning-model` component only and now aligns with the
  inventory receipt boundary claim.

### Notes for Users

- This is a companion Harness release, not an Assay release. Use it with Assay
  `v3.7.0`, or a later binary that emits the same Trust Basis diff schema v1 /
  Trust Card schema v5 / 10-claim surface.
- This is not Promptfoo, OpenFeature, or CycloneDX integration or partnership
  support. These are copyable downstream recipes over existing Assay and Assay
  Harness contracts.

## [0.2.0] - 2026-04-27

This companion release makes the Trust Basis gate/report bridge and Promptfoo
receipt pipeline recipe release-ready above the Assay v3.6.0 evidence
portability line.

### Trust Basis CI Gate

- **Trust Basis regression gate**: `assay-harness trust-basis gate` delegates to
  `assay trust-basis diff --format json --fail-on-regression`, persists the raw
  `assay.trust-basis.diff.v1` artifact, and maps outcomes for CI without
  reimplementing Trust Basis semantics.
- **Trust Basis reporters**: `assay-harness trust-basis report` reads strict
  `assay.trust-basis.diff.v1` input and emits Markdown job-summary and minimal
  JUnit projections. The raw Assay diff JSON remains canonical; projections are
  views only.
- **Contract fixture bridge**: checked-in Trust Basis fixtures and raw Assay diff
  artifacts prove Harness consumes real Assay output rather than parallel local
  fixture semantics.

### Promptfoo Receipt Pipeline Recipe

- **Runnable recipe**: `demo/run-promptfoo-receipt-pipeline.sh` shows the full
  downstream path: Promptfoo CLI JSONL -> Assay receipts -> Trust Basis ->
  Harness gate/report.
- **Boundary discipline**: Harness still does not parse Promptfoo JSONL, inspect
  receipt payloads, or decide whether eval outcomes are true. Promptfoo remains
  the CI/eval runner; Assay owns artifact semantics; Harness owns CI
  orchestration and review projection.

### Notes for Users

- This release is a companion Harness release, not an Assay release. Use it with
  an Assay binary that includes `assay evidence import promptfoo-jsonl` and
  `assay trust-basis diff`.
- This is not a Promptfoo integration or partnership claim. It is a copyable
  downstream recipe over existing Assay and Assay Harness contracts.
