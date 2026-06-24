# Assay Harness

**The verified last mile from Assay evidence to reviewable CI artifacts.**

Assay Harness runs its recipes against released Assay capabilities and
produces verify-before-diff comparisons of baseline vs candidate evidence.
New denials, hash mismatches, or policy changes surface as structured
regression output — reviewable by humans and consumable by CI.

> **Version:** 0.9.0 | **Status:** active development

### What this is

A CI/review layer over canonical Assay artifacts: a recipe, gate, and report
projection. It *composes* released Assay capabilities; it does not define
artifact semantics — those live in Assay.

### What this is not

- not an agent runtime or execution harness
- not an eval runner
- not an observability platform or dashboard
- not a second policy or trust model beside Assay

The `assay` / `assay-action` / Assay-Harness split is compiler / button /
playbook: `assay` compiles evidence, `assay-action` is the one-click CI gate,
and Assay-Harness is the consumer that reviews claims against the evidence.

Adjacent product boundary: Assay-Harness is the open CI playbook for released
Assay artifacts. Plimsoll is the release-review product for capability-surface
deltas, human approval, and audit trails. Harness can prove and gate the
underlying shapes; Plimsoll decides whether a release ships.

### Optional input: Assay-Runner measured-run archives

Assay-Harness can read [Assay-Runner](https://github.com/Rul1an/assay) measured-run archives (`.tar.gz` carrying `assay.runner.archive_manifest.v0`) and the precomputed cross-runtime diff JSON Runner produces. This is opt-in alongside the existing NDJSON evidence path; NDJSON callers are unaffected.

Ten Runner-aware verbs are available:

| Verb | What it does | CI exit on regression |
|---|---|---|
| `assay-harness verify-runner <archive.tar.gz>` | Validate one archive's manifest, per-file SHA-256, and honest-health | — (single archive) |
| `assay-harness compare --baseline <a> --candidate <b>` (with `.tar.gz` inputs) | Tier-1 validation of both archives | n/a (Tier 1 only) |
| `assay-harness runner compare --baseline <a> --candidate <b>` | Strict Tier-2A capability-surface diff over two Tier-1-clean archives | `6` |
| `assay-harness runner cross-runtime report --diff <diff.json>` | Reviewer projection of `cross_runtime_diff.v0` (informational) | `0` (rendered only) |
| `assay-harness runner cross-runtime gate --diff <diff.json>` | CI-blocking gate on the same cross-runtime signal | `6` |
| `assay-harness runner coverage report --annotation <annotation.json>` | Reviewer projection of an `assay.coverage_aware_drift.annotation.v0` sidecar — per-dimension claim cells (strength × basis) and blocked claims | `0` (rendered only) |
| `assay-harness runner coverage gate --annotation <annotation.json> --assert-claim TYPE:DIM[,...]` | CI-blocking gate that permits an asserted coverage claim only when the annotation supports it (`--format text\|json\|sarif`) | `6` |
| `assay-harness runner coverage fleet --dir <dir>` | Fold many annotation sidecars into one fleet summary: per-dimension strength distribution + the fleet floor (strongest positive supportable across *every* run) | `0` (rendered only) |
| `assay-harness runner claims report --claims <claims.json> --annotation <annotation.json>` | Per asserted claim: does the observed evidence support it at the required strength? Outcomes: `supported` / `degraded` / `blocked` / `not_evaluable` | `0` (rendered only) |
| `assay-harness runner claims gate --claims <claims.json> --annotation <annotation.json>` | CI-blocking gate: passes only when every claim is `supported` (or `degraded` with `--allow-degraded`) | `6` |

### Claim support (`runner claims`)

`runner claims` reads a claim-assertions document (`assay.harness.claim_assertions.v0`)
plus a coverage annotation, and asks, per claim, whether the independently
observed evidence supports it at the required strength — and if not, what the
evidence does support. It speaks the claim-support vocabulary directly: `claim_kind`
∈ {`positive`, `exhaustive`, `bounded_negative`}; observed-effect dimension names
(`filesystem_paths_touched`, `network_endpoints`, …); `claim_strength` ∈
{`strong`,`partial`,`weak`,`absent`}; `claim_basis` ∈
{`measured`,`reported`,`derived`,`inferred`}.

Outcomes: `supported` (evidence meets the required strength × basis),
`degraded` (the effect is observed but weaker than required), `blocked`
(evidence contradicts the claim or coverage cannot justify it), `not_evaluable`
(no observed evidence for the dimension; fail-safe — the gate blocks). A claim's
`value`/`effect_class` are **advisory only** — support is evaluated at dimension
granularity and these are not independently verified. Observed support is the
ceiling; attestation is not consulted. Consumer-only: no new Runner capture, no
attestation adapter, no state.

Full reference, the four outcomes, the claim-support vocabulary, runnable examples,
and a CI-gate snippet: **[docs/CLAIM_SUPPORT.md](docs/CLAIM_SUPPORT.md)**. Worked
examples: [`examples/claims-clean/`](examples/claims-clean/) (all supported) and
[`examples/claims-eval-honesty/`](examples/claims-eval-honesty/) (over-claims
blocked).

### Coding-agent governance (`runner sandbox`)

`runner sandbox` consumes the evidence-bundle events that `assay sandbox --bundle`
emits when a coding agent runs under the sandbox (`assay.sandbox.summary` / `.fs`
/ `.exec` / `.degraded`). It reports the observed filesystem operations, executed
programs, and containment degradations, and gates on them:

```bash
assay-harness runner sandbox report --events events.json
assay-harness runner sandbox gate --events events.json [--allow-degraded]
```

The gate exits `6` when a containment degradation is present (enforcement was
weakened while the run continued) unless `--allow-degraded` is set; observed
fs/exec effects alone never fail the gate, they are the record. Consumer-only: no
capture, no new semantics. Worked example:
[`examples/coding-agent-sandbox/`](examples/coding-agent-sandbox/). Honest
boundary: this reports what the sandbox observed, not intent, and Landlock is not
VM-level isolation.

### Coverage claims (the honesty model)

`runner coverage` consumes the coverage annotation the comparator emits with
`--coverage-annotation-out`. It decides each asserted claim from
`claim_strength × claim_basis`, never inventing or upgrading a claim:

- `positive:DIM` — permitted only on a `measured_DIM_drift` cell with strength `strong`/`partial`.
- `exhaustive:DIM` — permitted only when `exhaustive_DIM_equality` is allowed (`partial`); a coverage-degraded `weak` cell is not.
- `bounded_negative:DIM` — permitted only on a measured dimension that is not in `blocked_claims`; not evaluable on a reported/unknown dimension.

The gate exits `6` on any blocked asserted claim and can emit SARIF 2.1.0
(`--format sarif`) so blocked claims surface in code-scanning UIs. Harness
*composes* this published Assay shape; it defines no claim semantics of its own.

What a Tier-2A regression looks like when an agent gains a new MCP tool between baseline and candidate:

```text
# Runner Capability-Surface Diff (Tier 2A)

**Status:** RUNNER CAPABILITY REGRESSION
**Summary:** RUNNER CAPABILITY REGRESSION: filesystem_paths_added:1, mcp_tools_added:1, policy_allow_decisions_added:1

## MCP Tools
Added:
- `write_file`
```

Exit `6`.

A reproducible end-to-end walkthrough with all four verbs, using locally-generated synthetic fixtures (no live eBPF, no delegated host), lives in [`docs/DEMO_RUNNER.md`](docs/DEMO_RUNNER.md). The full per-verb exit-code contract lives in [`docs/contracts/EXIT_CODES.md`](docs/contracts/EXIT_CODES.md).

Runner archives and cross-runtime diffs are defined and produced by the Runner side of [`Rul1an/assay`](https://github.com/Rul1an/assay) — an internal measured-run subsystem of Assay, **not a standalone product**. Harness consumes and gates; it does not measure and does not compute cross-runtime diffs. Producing a cross-runtime diff from a raw archive pair (Tier 3B) remains deferred as a future demo recipe.

---

## Supply-chain conformance carrier gate (`carrier supply-chain`)

Assay (`crates/assay-registry`) emits an `assay.supply_chain_conformance.v0`
carrier when it verifies pack provenance: per-dimension integrity, provenance
(including the Sigstore-keyless dimensions), and pinning statuses, plus an
aggregate `policy_result`. The Harness consumes that carrier as a CI gate.

```bash
# Gate CI on a supply-chain conformance carrier and write reviewer artifacts
npx tsx harness/src/cli.ts carrier supply-chain \
  --carrier path/to/supply-chain-conformance.json \
  --out-dir results/supply-chain-conformance
```

It validates the frozen v0 shape, gates on the producer-owned `policy_result`
(`pass` is clean; `fail` and `incomplete` are not, and `incomplete` is never read
as clean), and projects Markdown, JUnit, and SARIF. An unknown status or unknown
`policy_result` is rejected as a contract error rather than passing silently.

Consumer-not-owner: the Harness surfaces the carrier's own producer-computed
verdict and per-dimension statuses. It does not approve, certify, judge
compliance, or assert provider trust, runtime truth, or supply-chain safety;
policy-aware review is a separate step. See
`harness/fixtures/supply-chain-conformance/` and
`demo/run-supply-chain-conformance-gate.sh`.

## Render-safety conformance carrier gate (`carrier render-safety`)

Assay (`crates/assay-core/src/render_safety`) emits an
`assay.render_safety_conformance.v0` carrier: per render sink it records raw
secret / PII / terminal-control leak counts, redaction-before-truncation, and
benign-preserved. The Harness gates CI on those facts.

```bash
npx tsx harness/src/cli.ts carrier render-safety \
  --carrier path/to/render-safety-conformance.json \
  --out-dir results/render-safety-conformance
```

A sink is clean iff it leaked no raw secret/PII/terminal-control, preserved benign
output, and honoured redaction-before-truncation; the report is clean iff every
sink is clean. This covers render output safety per sink only, not secret
lifecycle, vaulting, or rotation.

## Token-passthrough conformance carrier gate (`carrier token-passthrough`)

Assay (`crates/assay-mcp-server/src/token_passthrough.rs`) emits an
`assay.token_passthrough_conformance.v0` carrier: value-free, it records that a
consumed inbound authentication value is not re-emitted on a checked outbound
channel (transport header, JSON body, spawned env). The Harness gates CI on those
per-channel facts.

```bash
npx tsx harness/src/cli.ts carrier token-passthrough \
  --carrier path/to/token-passthrough-conformance.json \
  --out-dir results/token-passthrough-conformance
```

The carrier is clean iff every checked outbound channel reports `leak_count == 0`
and is not `pass == false`; `not_applicable` channels are out of scope. This covers
the confused-deputy boundary only, not arbitrary payload scrubbing, provider token
grants, or token lifecycle.

## Enforcement-health conformance carrier gate (`carrier enforcement-health`)

Assay (`crates/assay-cli/src/enforcement_health_v1.rs`) emits an
`assay.enforcement_health.v1` carrier for the Landlock TCP-connect port-allowlist
domain: whether enforcement was `active` (the ruleset was applied) or `failed`
(requested but not installed), plus an optional real-block probe. The Harness gates
CI on that producer-reported status.

```bash
npx tsx harness/src/cli.ts carrier enforcement-health \
  --carrier path/to/enforcement-health.json \
  --out-dir results/enforcement-health
```

`status=active` is clean; `status=failed` is not clean. A real-block probe upgrades
the evidence to "a denied connect was really blocked before the listener was
reached" and is surfaced, but is not required for a clean gate.

This is the carrier-local honest-state gate (was enforcement requested, and did the
ruleset apply or fail), distinct from the enforcement-truth review (policy-aware
approval over the enforcement outcome), which is a separate step. Consuming this
carrier is a deliberate reversal of the earlier "the Harness does not consume
`enforcement_health`" position, scoped to the v1 (Landlock) domain; see
`docs/RUNNER_SCHEMA_CONSUMPTION.md`. The connect4/eBPF `v0` carrier is a different
shape and is not consumed here.

## MCP server inventory (`carrier inventory`, descriptive)

Assay (`assay mcp inventory`, `crates/assay-core/src/discovery/inventory_carrier.rs`)
emits an `assay.mcp_server_inventory.v0` carrier: a coverage-honest projection of
discovered MCP servers (command/args hashed, credentials flagged by name only). The
Harness projects it as reviewer context.

```bash
npx tsx harness/src/cli.ts carrier inventory \
  --carrier path/to/mcp-server-inventory.json \
  --out-dir results/mcp-server-inventory
```

This is **descriptive / non-gating**: a valid inventory exits 0 regardless of
contents; only a malformed / wrong-schema / unknown-coverage-state carrier is a
contract error (exit 3). Coverage honesty is surfaced, never decided: only a
`complete` scan supports an absence claim, so the projection states which sources
are complete and whether the inventory can support "nothing else is there". Drift
and approval over the inventory (e.g. an unexpected server) are a separate review
step.

The other descriptive Tier-2B carriers, `tool_decision_surface.v0` and
`mcp_manifest_observed.v0`, are not yet adapted (no clean single-carrier golden to
pin against); they are a tracked follow-up, not hidden debt.

## Coding-agent run evidence (`carrier coding-agent`, descriptive)

Assay (`crates/assay-evidence/src/coding_agent.rs`, `coding_agent_evidence_event`) emits an
`assay.coding_agent.evidence_pack.v0` evidence event for one coding-agent run: declared scope, observed
effects, per-surface coverage, source class, and non-claims, with a hard content hash (`assaycontenthash` on
the wire) on the event. The
Harness validates the frozen shape and projects a reviewer-facing review surfacing the signals a 2026
agent-PR reviewer needs (what changed, what ran, what network/tools were touched, what was actually
observed).

```bash
npx tsx harness/src/cli.ts carrier coding-agent \
  --carrier path/to/coding-agent-evidence-event.json \
  --out-dir results/coding-agent
```

This is **descriptive / non-gating**: a valid event exits 0 regardless of contents; only a malformed /
wrong-type / missing-required-field event is a contract error (exit 3). The review surfaces declared-vs-
observed scope deltas, coverage gaps on the core surfaces (`files`, `commands`, `network`, `mcp_tools`; an
unobserved surface is a visible gap, never a clean result), the source-class basis (a self-attested class
does not on its own support a clean review), and the producer's `content_hash` integrity anchor (surfaced,
not re-verified here). It computes **no verdict** and no effect-sufficiency: the bounded judgment over these
facts is a separate downstream review consumer's job. Unlike the schema-keyed carriers, the coding-agent evidence is
an EvidenceEvent identified by `type`, so it has its own verb and is not in the `carrier check` registry.

**Carrier projection only (intentional).** A full `suite.evidence_pack.v0` carrying this carrier is not built
yet: that needs a *released* Assay with the primitive, a hermetic recipe that emits the carrier, and a
*proven* suite-matrix row, so the pack's coherence invariant holds without fabricated provenance. The
projection lands now; the coherence-bound pack follows once those exist.

## Carrier contract-drift check (`carrier check`)

`carrier check` dispatches any conformance carrier by its `schema` id to the
registered adapter and reports whether the Harness recognizes the contract and the
carrier matches its frozen shape. It is the schema / shape dimension only, distinct
from the per-carrier gate verbs: a well-formed carrier that reports a leak is
contract-valid here (exit 0) and fails its own gate verb (exit 6) separately.

```bash
npx tsx harness/src/cli.ts carrier check --carrier path/to/conformance.json
```

An unknown or unregistered `schema` id, a missing/non-string `schema`, malformed
JSON, or a recognized schema whose shape has drifted is a contract error (exit 3):
the Harness never silently accepts a carrier it does not recognize. A golden-drift
test pins every registered schema's shape, so a future producer change is caught
rather than mis-parsed.

## Suite compatibility matrix (`suite check` / `suite matrix`)

The suite compatibility matrix (`suite.compatibility.v0`, checked in at
`harness/suite-compatibility.json`) is a versioned suite-contract artifact: it records
which Assay version emits each carrier, which Harness version consumes/projects/gates
it, which Plimsoll version reviews it, the support mode, the public/private backing, and
the proof state. It is a VSA-shaped compatibility summary, not a SLSA VSA. The Harness
validates this evidence and projects it; it does not approve carrier semantics or
organization policy.

Each row splits the proof in two, which is the load-bearing honesty: `harness_consumption`
(the Harness can validate/gate/project the carrier shape, proven by this repo's tests over
real producer golden bytes) and `end_to_end` (the released Assay binary emitted the carrier
and the Harness consumed it in a hosted run). A `declared / pending` end-to-end state means
the first is proven but the second is not yet, so it renders as pending, never as approved.

```bash
# Validate the matrix shape + digest only
npx tsx harness/src/cli.ts suite check --matrix harness/suite-compatibility.json

# Also check drift vs the live carrier registry (CI)
npx tsx harness/src/cli.ts suite check --matrix harness/suite-compatibility.json --against-registry

# Project a reviewer-facing Markdown (or JSON) view
npx tsx harness/src/cli.ts suite matrix --matrix harness/suite-compatibility.json
```

A malformed matrix, an unknown enum state, a digest mismatch, a `proven` end-to-end row
without its `hosted_run` + `artifact_digest`, or (in registry mode) drift between the
matrix and the registry is a contract error (exit 3). An unknown state is never clean.

## Evidence Pack (`evidence-pack create` / `evidence-pack verify`)

An Evidence Pack (`suite.evidence_pack.v0`) is a deterministic, digest-bound bundle of a
proven carrier recipe. It binds raw Assay carrier bytes, the Harness Markdown projection,
the suite compatibility matrix, and the recipe provenance (`suite.recipe_provenance.v0`) by
digest. It creates no new evidence, approves no policy, and does not replace Plimsoll — it is
VSA-shaped, not a SLSA VSA. v0 carries proven recipes — the inventory recipe and the
released-binary supply-chain DSSE clean/pass recipe.

```bash
# Build a pack from a proven recipe's outputs
npx tsx harness/src/cli.ts evidence-pack create \
  --carrier carriers/assay.mcp_server_inventory.v0.json \
  --suite-matrix harness/suite-compatibility.json \
  --provenance recipe.provenance.json \
  --markdown inventory.review.md \
  --out evidence-pack/

# Verify a pack (strict)
npx tsx harness/src/cli.ts evidence-pack verify evidence-pack/
```

`verify` separates source-of-truth (carrier, matrix, provenance) from lossy projections
(every projection must resolve to a source digest), enforces path safety (no `..` / absolute
/ symlink / duplicate / unlisted / escaping paths), and holds the **coherence invariant**: the
carrier bytes, the matrix, and the provenance must all agree on the same artifact and the same
proof — covering the binary, command, fixture, runner, and hosting context, not just the artifact
digest. The packed proof may live in the carrier's own matrix row (carrier-row-bound) or in exactly
one recipe row (recipe-row-bound, matched on `end_to_end=proven` + `hosted_run` + `artifact_digest`);
either way the subject's carrier row must exist and be proven, and `verify` reports which route bound
via `coherence_binding`. A pack cannot be internally consistent by digest while lying about where the
evidence came from. The manifest digest is deterministic over the evidence (volatile metadata
excluded), so identical evidence yields the same pack identity.

### External attestation cross-check (`suite.evidence_pack.v1`)

`v1` is a strict superset of `v0`: all the v0 invariants, plus exactly one external GitHub
artifact-attestation bundle (a Sigstore `v0.3` bundle) and its `suite.external_attestation_source.v0`
metadata. `v0` stays frozen — it carries no `external_evidence`, and `external_evidence` in the
core digest is v1-only, so a `v0` pack's identity never changes. `verify` decodes the bundle's
in-toto subject for **integrity** (the declared subject must be one the bundle attests), checks the
media-type family and the harness-posture flags, and holds the binding: the attested subject must
equal `recipe_provenance.release_asset.digest` — the release asset the recipe downloaded and
verified before extracting the binary. GitHub attested the release asset, **not** the extracted
binary; `assay.binary_digest` stays a separate field and is never equated with the attested subject.
The Harness decodes and cross-checks the attestation subject against
`recipe_provenance.release_asset.digest`; it does **not** verify the attestation's signature, trusted
root, transparency-log (Rekor) inclusion, issuer identity, or policy compliance — the bundle is
included and digest-bound, never asserted as trusted or verified.

## The PR Gate Flow

```
baseline evidence (main)     candidate evidence (PR branch)
        │                              │
        └──────────┬───────────────────┘
                   │
          assay-harness compare
                   │
         ┌─────────┴──────────┐
         │  Regression Report  │
         │  ─ new denials?     │
         │  ─ hash mismatches? │
         │  ─ counter deltas?  │
         └─────────────────────┘
                   │
           exit 0 (ok) or exit 6 (regression)
```

### Try it now (no API key needed)

```bash
cd harness && npm install

# Compare two evidence files
npx tsx src/cli.ts compare \
  --baseline ../fixtures/valid.assay.ndjson \
  --candidate ../fixtures/failure.assay.ndjson

# Output:
# # Evidence Comparison Report
# **Status:** REGRESSION DETECTED
# **Summary:** REGRESSION: 1 new denial(s), ...
```

### What triggers a regression?

| Signal | Meaning | Exit code |
|---|---|---|
| New denial | A tool that was allowed is now denied | 6 |
| New event type | Unknown evidence category appeared | 6 |
| Hash mismatch | Same event at same seq has different content | 6 |
| Increased denied count | More actions blocked than baseline | 6 |

Removed denials, approval changes, and counter decreases are reported
as **changes** but do not fail the gate.

---

## Quick Start

### 0. Manage baselines

```bash
# Store current evidence as baseline
npx tsx src/cli.ts baseline update --from ../fixtures/valid.assay.ndjson

# Inspect baseline
npx tsx src/cli.ts baseline show
# → [baseline] events: 4
# →   - example.placeholder.harness.approval-interruption
# →   - example.placeholder.harness.policy-decision
# →   - ...
```

### 1. Policy evaluation

The policy engine is deterministic: same tool name, same decision, every time.
No transcript, no model reasoning, no volatile state.

```bash
npx tsx src/cli.ts policy --tool read_file
# → { "decision": "allow", ... }

npx tsx src/cli.ts policy --tool write_file
# → { "decision": "require_approval", ... }

npx tsx src/cli.ts policy --tool network_egress
# → { "decision": "deny", ... }   (exit 1)
```

### 2. Map fixtures to Assay evidence

```bash
python3 mapper/map_to_assay.py \
  fixtures/valid.harness.json \
  --output /tmp/valid.assay.ndjson \
  --import-time 2026-04-16T12:00:00Z \
  --overwrite

# Malformed fixtures are rejected with canonical codes
python3 mapper/map_to_assay.py \
  fixtures/malformed.harness.json \
  --output /tmp/malformed.ndjson \
  --import-time 2026-04-16T12:10:00Z \
  --overwrite
# → [REJECT_RAW_STATE] rejected key 'raw_run_state'
```

### 3. Verify evidence contracts

```bash
npx tsx src/cli.ts verify ../fixtures/valid.assay.ndjson --category all
# Checks: envelope fields, SHA-256 hashes, type prefixes, rejected keys
```

### 4. Generate CI outputs

```bash
# JUnit XML (denied actions become <failure> elements)
python3 ci/emit_junit.py fixtures/valid.assay.ndjson --output results/junit.xml

# SARIF 2.1.0 (uploads to GitHub Security tab)
python3 ci/emit_sarif.py fixtures/valid.assay.ndjson --output results/sarif.json
```

### 5. Export to OTel (experimental)

```bash
python3 ci/emit_otel.py fixtures/valid.assay.ndjson --output results/otel-export.json
# Produces OTLP-shaped JSON for integration with Jaeger, Grafana Tempo, etc.
```

See [docs/contracts/OTEL_EXPORT.md](docs/contracts/OTEL_EXPORT.md) for mapping rules
and stability caveats.

### 6. Run the Promptfoo receipt pipeline recipe

Promptfoo can produce AI eval outputs in CI; Assay compiles selected outcomes
into evidence receipts and Trust Basis artifacts; Harness gates/reports the
resulting Trust Basis diff.

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-promptfoo-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-promptfoo-receipt-pipeline \
    --overwrite
```

See [docs/PROMPTFOO_RECEIPT_PIPELINE.md](docs/PROMPTFOO_RECEIPT_PIPELINE.md)
for the artifact chain and boundary rules.

### 7. Run the OpenFeature decision receipt pipeline recipe

OpenFeature can surface runtime flag evaluation details; Assay compiles one
bounded boolean `EvaluationDetails` input path into decision receipts and Trust
Basis artifacts; Harness gates/reports the resulting Trust Basis diff.

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-openfeature-decision-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-openfeature-decision-receipt-pipeline \
    --overwrite
```

See [docs/OPENFEATURE_DECISION_RECEIPT_PIPELINE.md](docs/OPENFEATURE_DECISION_RECEIPT_PIPELINE.md)
for the artifact chain and boundary rules.

### 8. Run the CycloneDX ML-BOM model receipt pipeline recipe

CycloneDX ML-BOM can describe AI/ML inventory surfaces; Assay compiles one
selected `machine-learning-model` component into inventory receipts and Trust
Basis artifacts; Harness gates/reports the resulting Trust Basis diff.

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-cyclonedx-mlbom-model-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-cyclonedx-mlbom-model-receipt-pipeline \
    --overwrite
```

See [docs/CYCLONEDX_MLBOM_MODEL_RECEIPT_PIPELINE.md](docs/CYCLONEDX_MLBOM_MODEL_RECEIPT_PIPELINE.md)
for the artifact chain and boundary rules.

These receipt recipes require the released Assay `v3.8.0` Trust Basis surface
or a later compatible release, tracking Assay through `v3.27.0` (release-binary
proof verified through `v3.27.0`) for
`assay.trust-basis.diff.v1`, Trust Card schema v5, and the 10-claim eval /
decision / inventory family set, with machine-readable receipt contracts owned
by Assay. See
[docs/ASSAY_COMPATIBILITY.md](docs/ASSAY_COMPATIBILITY.md) for the exact
compatibility boundary.

### 9. Run the harness (requires OPENAI_API_KEY)

```bash
cd harness
export OPENAI_API_KEY=sk-...
npx tsx src/cli.ts run \
  --input "List files in /tmp and write a summary to /tmp/summary.txt" \
  --auto-approve
```

---

## CI Integration

The regular GitHub Actions workflow runs 8 jobs on every push and PR. A manual
`workflow_dispatch` compatibility job is available before releases to test the
receipt recipes against a chosen Assay release binary.

| Job | What it checks |
|---|---|
| TypeScript Check | `tsc --noEmit` passes |
| Contract Validation | Mapper produces golden NDJSON, malformed input rejected |
| Golden Contract Tests | 24 tests: envelope, hashing, NDJSON format, rejection |
| Hardening Tests | 27 tests: resume safety, policy determinism, MCP boundaries |
| Policy Validation | allow/deny/require_approval decisions are correct |
| Verify Evidence | Evidence files pass all contract categories |
| **Regression Gate** | **Baseline vs candidate compare — blocks on regressions** |
| Evidence Export | Evidence JUnit + SARIF generated, artifacts uploaded |
| Assay Release Compatibility Recipes | Manual proof against a chosen Assay release binary |

Evidence export can generate SARIF for generic evidence findings and upload it
to the GitHub Security tab. Trust Basis gate/report output is different by
design: the canonical artifact is raw `assay.trust-basis.diff.v1` JSON, with
Markdown and JUnit projections only. Trust Basis recipes do not emit SARIF.

For this line, Assay Harness is distributed as the repository CLI and GitHub
release artifacts. The `harness/package.json` version tracks release metadata;
it is not an npm publication claim.

---

## Demo Scenarios

Four concrete scenarios in `fixtures/scenarios/` show the key product flows:

| Scenario | What it demonstrates |
|---|---|
| `clean-baseline` | No regressions — compare exits 0 |
| `new-approval` | PR introduces new `require_approval` tool |
| `deny-regression` | Policy change causes new denial |
| `policy-drift-resume` | Resume with different policy snapshot hash |

Run all scenarios locally:

```bash
bash demo/run-scenarios.sh
```

See [docs/SCENARIOS.md](docs/SCENARIOS.md) for details on each scenario.

---

## Regression Classes

The `compare` command detects these regression dimensions:

```
New denials          — tool went from allowed → denied
Removed denials      — tool went from denied → allowed (change, not regression)
New approvals        — tool now requires approval
Removed approvals    — tool no longer requires approval
Event count delta    — more or fewer evidence events
New event types      — unknown event type appeared
Removed event types  — event type disappeared
Hash mismatches      — same event position, different content hash
Process counter delta — approval/denial/resume counts changed
```

Example compare output (markdown format):

```markdown
# Evidence Comparison Report

**Status:** REGRESSION DETECTED
**Summary:** REGRESSION: 1 new denial(s), event count delta: +0, 1 hash mismatch(es), 2 process counter change(s)

## New Denials

- `network_egress` (policy: harness-default-policy@1.0)

## Hash Mismatches

- seq 0 (`example.placeholder.harness.approval-interruption`)
  - baseline: `sha256:a1b2c3...`
  - candidate: `sha256:d4e5f6...`

## Process Summary Delta

| Counter | Baseline | Candidate | Delta |
|---------|----------|-----------|-------|
| denied_action_count | 0 | 1 | +1 |
| total_tool_calls | 3 | 3 | +0 |
```

---

## Stable Exit Codes

Every CLI command uses stable exit codes — safe for CI scripting:

| Code | Name | Meaning |
|---|---|---|
| 0 | success | No failures or regressions |
| 1 | policy_violation | Tool call denied by policy |
| 2 | config_error | Missing file or bad configuration |
| 3 | artifact_contract | Evidence fails contract validation |
| 4 | mapper_failure | Mapper rejected input |
| 5 | resume_error | Resume flow failed |
| 6 | regression | Baseline comparison found regressions |
| 7 | ci_formatter | JUnit/SARIF generation failed |

See [docs/contracts/EXIT_CODES.md](docs/contracts/EXIT_CODES.md) for per-command behavior.

---

## Policy Model

```yaml
tools:
  allow:
    - read_file
    - list_directory
  deny:
    - network_egress
    - delete_file
  require_approval:
    - write_file
    - shell_exec
```

Evaluation order: **deny > require_approval > allow > default deny** (closed-by-default).

Policy uses only: tool name, tool category, target kind.
No transcript, model reasoning, or volatile state influences the decision.
See [ADR-001](docs/adr/ADR-001-DETERMINISTIC-POLICY.md).

---

## Evidence Boundaries

This harness explicitly does **not** claim:

- transcript truth
- session truth
- provider-chaining truth
- full RunState truth
- full MCP protocol truth

**Observed is not verified.** Runtime signals are evidence input, not
verification output. See [ADR-002](docs/adr/ADR-002-NO-TRANSCRIPT-TRUTH.md)
and [ADR-003](docs/adr/ADR-003-MCP-BOUNDED-EVIDENCE.md).

**`resume_state_ref` is an app-level fingerprint, not a portable wire hash.**
Per SDK guidance ([openai/openai-agents-js#1177](https://github.com/openai/openai-agents-js/issues/1177)),
`RunState.toString()` guarantees resumability via `fromString()` but does not
guarantee byte-stability across SDK versions. Consumers that need byte-stable
identity across SDK upgrades should derive their own anchor. See
[docs/FIELD_PRESENCE.md](docs/FIELD_PRESENCE.md) for the full seam documentation.

---

## Project Structure

```
Assay-Harness/
  harness/                    # TypeScript runtime
    src/
      cli.ts                  # CLI: run, verify, compare, policy
      policy.ts               # Deterministic policy engine
      harness.ts              # Pause/resume orchestrator
      evidence.ts             # CloudEvents envelopes + SHA-256 hashing
      compare.ts              # Baseline vs candidate regression detection
      agent.ts                # Agent definition + tools
      mcp.ts                  # MCP tool lane (bounded evidence)
    policy.yaml               # Default policy
  mapper/                     # Python evidence mapper
    map_to_assay.py           # Harness JSON → Assay NDJSON
  fixtures/                   # Test corpus
    valid.harness.json        # Approval interruption artifact
    failure.harness.json      # Partial failure artifact
    malformed.harness.json    # Rejected (raw state, bad pause_reason)
    valid.assay.ndjson        # Golden mapper output
    failure.assay.ndjson      # Golden mapper output
    valid.mcp.harness.json    # MCP interaction fixture
    scenarios/                # Demo scenario fixtures
      clean-baseline.*        # No-regression baseline
      new-approval.*          # New require_approval tool
      deny-regression.*       # Policy tightening
      policy-drift-resume.*   # Policy snapshot mismatch
  demo/
    run-scenarios.sh          # Run all demo scenarios locally
  tests/                      # Python test suites
    test_contracts.py         # 24 golden contract tests
    test_hardening.py         # 22 hardening tests
  ci/                         # CI output generators
    emit_junit.py             # Evidence → JUnit XML
    emit_sarif.py             # Evidence → SARIF 2.1.0
    emit_compare_junit.py     # Compare results → JUnit XML
    emit_compare_sarif.py     # Compare results → SARIF 2.1.0
    emit_otel.py              # Evidence → OTLP JSON (experimental)
  docs/
    contracts/                # Stable contracts
      EVIDENCE_ENVELOPE.md    # CloudEvents envelope spec
      EXIT_CODES.md           # CLI exit code contract
      REJECT_CODES.md         # Mapper rejection codes
      OTEL_EXPORT.md          # OTel export mapping (experimental)
    adr/                      # Architecture decisions
      ADR-001-*.md            # Deterministic policy
      ADR-002-*.md            # No transcript truth
      ADR-003-*.md            # MCP bounded evidence
    SCENARIOS.md              # Demo scenario documentation
    ROADMAP.md                # Now / next / later roadmap
  .github/workflows/
    harness-ci.yml            # 8-job CI pipeline (incl. regression gate)
    release.yml               # Tag-triggered release with attestations
    sbom.yml                  # Dependency submission on push to main
```

---

## Relationship to Assay

Companion project to [Assay](https://github.com/Rul1an/assay).
Follows Assay's evidence conventions, policy model, and artifact contract
patterns. The mapper produces Assay-shaped NDJSON consumable by Assay's
evidence tooling.

---

## License

MIT
