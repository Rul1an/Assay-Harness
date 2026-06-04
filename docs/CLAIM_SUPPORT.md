# Claim support (`runner claims`)

`runner claims` checks the claims an agent, eval, harness, or report makes
against independently observed evidence (an
`assay.coverage_aware_drift.annotation.v0` coverage annotation). For each claim
it answers one question: **does the observed evidence support this claim at the
required strength, and if not, what does the evidence support?**

It is a consumer of already-shipped Assay surfaces. It defines no new claim
semantics, adds no Runner capture, consults no attestation, and keeps no state.
Observed support is the ceiling.

## Verbs

| Verb | What | Exit |
|---|---|---|
| `assay-harness runner claims report --claims <c.json> --annotation <a.json>` | Per-claim support report (markdown or `--format json`) | `0` |
| `assay-harness runner claims gate --claims <c.json> --annotation <a.json> [--allow-degraded]` | CI gate: passes only when every claim is `supported` (or `degraded` with `--allow-degraded`) | `6` on failure |

Exit codes: `0` pass, `2` usage error, `3` invalid claims/annotation, `6` one or
more claims not supported.

## Outcomes

| Decision | Meaning |
|---|---|
| `supported` | observed evidence meets the required `claim_strength` × `claim_basis` |
| `degraded` | the effect is observed, but weaker than required — the evidence supports a weaker version |
| `blocked` | the evidence contradicts the claim, or the coverage method cannot justify it (e.g. cannot prove a negative) |
| `not_evaluable` | no observed evidence for the dimension — fail-safe: the gate blocks |

## Vocabulary (open-core, no second layer)

- `claim_kind`: `positive`, `exhaustive`, `bounded_negative`
- `dimension`: open-core names — `filesystem_paths_touched`, `kernel_file_operations`, `network_endpoints`, `process_execs`
- `claim_strength`: `strong | partial | weak | absent`
- `claim_basis`: `measured | reported | derived | inferred`

A claim's `value` / `effect_class` are **advisory** and are not independently
verified — support is evaluated at dimension granularity.

## Examples

- [`examples/claims-clean/`](../examples/claims-clean/) — every claim supported; gate exits `0`.
- [`examples/claims-eval-honesty/`](../examples/claims-eval-honesty/) — two over-claims blocked for two different honest reasons, one supported; gate exits `6`.

## Use in CI (release gate)

`runner claims gate` is a deterministic exit-code gate, so it drops into any CI
step. Example GitHub Actions usage as a release gate:

```yaml
- name: Build harness
  run: cd harness && npm ci && npm run build
- name: Verify claimed effects against observed evidence
  run: |
    node harness/dist/cli.js runner claims gate \
      --claims claims.json \
      --annotation coverage-annotation.json
  # exit 6 fails the job when a claimed effect is not supported by the evidence
```

Pair it with the comparator's `--coverage-annotation-out` sidecar (the
annotation this verb consumes) to gate, at release time, that a report's claimed
effects are actually supported by what was observed.

## What it does not do

- No "safe" / "unsafe" verdict — only whether the evidence supports each claim.
- No assertion that the runner observed everything; `blocked` / `not_evaluable`
  reflect the visibility ceiling, not a judgement about the agent.
- No per-value verification (the `value`/`effect_class` are advisory).
- Attestation is not consulted; observed support is the ceiling.
