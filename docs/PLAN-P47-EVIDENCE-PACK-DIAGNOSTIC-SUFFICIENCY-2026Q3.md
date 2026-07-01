# P47 - Evidence Pack Diagnostic Sufficiency

> **Status:** DoR, not implemented
> **Target repo:** `Rul1an/Assay-Harness`
> **Source finding:** `retained-pack-diagnostic-sufficiency-2026-07`
> **SOTA anchor:** HarnessFix, arXiv:2606.06324

---

## One-Line Goal

Add a reviewer-facing diagnostic sufficiency layer for Evidence Packs so a valid
pack is not over-read as a localized failure unless retained bytes support one
step, one harness layer, and one reason class.

## Why Now

The July 2026 agent-harness frontier is moving from final-outcome scoring toward
trace-guided diagnosis and harness repair. HarnessFix shows the strongest nearby
pattern: failed trajectories are useful only when trace evidence can be normalized
enough to attribute failures to responsible trajectory steps and harness layers
before repair is attempted.

Assay-Harness already has a strong artifact contract for
`suite.evidence_pack.v0` and `suite.evidence_pack.v1`: path safety, digest
binding, projection-to-source coherence, provenance binding, and explicit
non-claims. That is necessary, but it is not the same predicate as diagnostic
localization.

P47 keeps those predicates separate:

- `evidence-pack verify` remains artifact-contract verification.
- Diagnostic sufficiency is an additional reviewer state over retained evidence.
- A valid pack may still be diagnostically insufficient or ambiguous.

## Lab Finding

The private lab probe `retained-pack-diagnostic-sufficiency-2026-07` generated
12 fixture records and reproduced them with a clean-room implementation. The key
result:

> `artifact verifies` is an artifact-contract claim. It does not imply
> `failure localized`.

The four states were:

| State | Meaning |
|---|---|
| `diagnostic_localized` | Retained bytes support one step, one layer, and one reason class. |
| `diagnostic_ambiguous` | The pack is artifact-valid, but multiple candidates or missing attribution fields prevent a single localization. |
| `diagnostic_insufficient` | The pack is artifact-valid, but retained source bytes, coverage, or source class cannot carry localization. |
| `invalid` | Shape, path, digest, or artifact-contract failure. Diagnostic semantics do not run. |

## Scope

P47 is a plan for a small reviewer-facing diagnostic layer. It is not a repair
engine.

In scope:

- define the diagnostic sufficiency state machine;
- define the retained fields required for `diagnostic_localized`;
- define reason classes for ambiguous and insufficient packs;
- render the diagnostic state in Evidence Pack output;
- keep artifact verification and diagnostic localization separate.

Out of scope:

- changing pack identity or manifest digest semantics;
- changing `evidence-pack verify` exit codes;
- patch generation or harness repair;
- benchmark performance claims;
- policy approval, compliance, provider trust, runtime truth, or safety claims;
- treating projections as source-of-truth.

## Proposed Contract

### Inputs

The diagnostic layer may inspect only retained pack data:

- manifest path and pack digest status;
- retained source bytes and their digests;
- projection metadata, including whether a projection is lossy;
- coverage by harness layer;
- observations containing:
  - `step_id`,
  - `layer`,
  - `state`,
  - `reason_class`,
  - `source_class`.

### Output

The layer returns:

```json
{
  "status": "diagnostic_localized",
  "ceiling": "step_layer_reason",
  "reason_classes": ["ringbuf_drops_nonzero"],
  "non_claims": [
    "artifact_valid_does_not_imply_repair",
    "diagnostic_state_is_not_policy_approval",
    "diagnostic_state_is_not_provider_truth",
    "diagnostic_state_is_not_runtime_truth",
    "projection_is_not_source_of_truth"
  ]
}
```

### State Rules

1. Artifact-contract failure wins first:
   - malformed pack,
   - unsafe path,
   - digest mismatch,
   - projection-source coherence failure,
   - external evidence shape failure.

   Result: `invalid`.

2. A pack can be `diagnostic_localized` only when all are true:
   - source bytes are retained;
   - the relevant layer has complete coverage;
   - there is exactly one failure atom;
   - that atom carries `step_id`, `layer`, and `reason_class`;
   - source class can carry the layer-localization claim.

3. Multiple plausible failure atoms are `diagnostic_ambiguous`, not
   `diagnostic_insufficient`.

4. Missing attribution fields are `diagnostic_ambiguous` when the artifact is
   otherwise retained and covered.

5. Projection-only or partial-coverage packs are `diagnostic_insufficient`.

6. SDK self-report can localize SDK-layer facts, but must not localize kernel,
   policy, or carrier-layer failures by itself.

7. Complete no-failure evidence may render `diagnostic_localized` at a
   `no_failure_observed` reason class only inside the declared retained boundary.

## Reason Classes

Initial reason classes:

| Reason class | State | Meaning |
|---|---|---|
| `no_failure_observed` | `diagnostic_localized` | Complete retained boundary has no failure atom. |
| `ringbuf_drops_nonzero` | `diagnostic_localized` | Kernel observation layer reports dropped events. |
| `policy_decision_mismatch` | `diagnostic_localized` | Policy layer contradicts the expected decision. |
| `source_bytes_missing` | `diagnostic_insufficient` | Pack has projection but not retained source bytes. |
| `projection_only` | `diagnostic_insufficient` | Localization would rely on a lossy projection. |
| `layer_coverage_not_complete` | `diagnostic_insufficient` | The implicated layer is not fully covered. |
| `self_reported_layer_cannot_localize` | `diagnostic_insufficient` | A self-reported source is being used outside its own layer. |
| `multiple_failure_candidates` | `diagnostic_ambiguous` | More than one candidate failure atom remains. |
| `missing_step_id` | `diagnostic_ambiguous` | Failure atom lacks step identity. |
| `missing_layer` | `diagnostic_ambiguous` | Failure atom lacks layer identity. |
| `missing_reason_class` | `diagnostic_ambiguous` | Failure atom lacks reason class. |

## Acceptance

P47 is ready to implement only when these are true:

- the diagnostic state machine is kept separate from `evidence-pack verify`;
- existing valid/invalid pack behavior and exit codes stay unchanged;
- fixtures include all four states: localized, ambiguous, insufficient, invalid;
- tests prove that an artifact-valid projection-only pack is not localized;
- tests prove that two plausible failure atoms are ambiguous, not insufficient;
- tests prove that partial layer coverage cannot localize a failure;
- tests prove that malformed/path/digest errors return invalid before diagnostic
  semantics run;
- rendered output carries the non-claims above;
- docs state that diagnostic sufficiency does not imply repair, policy approval,
  provider truth, runtime truth, or safety.

## Implementation Shape

Recommended minimal implementation:

1. Add an internal diagnostic classifier next to Evidence Pack formatting, not
   inside the manifest digest calculation.
2. Add a JSON section to `evidence-pack verify --format json`.
3. Add a Markdown section to the existing pack rendering:
   `Diagnostic sufficiency`.
4. Keep CLI exit codes unchanged:
   - artifact invalid remains exit `3`;
   - artifact valid remains exit `0`;
   - diagnostic state is reviewer-facing data.

Do not add a failing CI gate in the first implementation. A later gate can be
considered only when a concrete workflow requires localized diagnostics.

## Sources

- HarnessFix: "From Failed Trajectories to Reliable LLM Agents: Diagnosing and
  Repairing Harness Flaws", arXiv:2606.06324, 4 Jun 2026.
  https://arxiv.org/abs/2606.06324
- Private lab probe: `retained-pack-diagnostic-sufficiency-2026-07`, 12 vectors
  with clean-room reproduction.
