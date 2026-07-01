# P47 - Evidence Pack Diagnostic Sufficiency

> **Status:** DoR, producer build held; consumer contract pinned by Plimsoll
> **Target repo:** `Rul1an/Assay-Harness`
> **Source finding:** `retained-pack-diagnostic-sufficiency-2026-07`
> **SOTA anchor:** HarnessFix, arXiv:2606.06324

---

## One-Line Goal

Keep an implementation-ready producer contract for a reviewer-facing diagnostic
sufficiency layer. The first named consumer now exists: Plimsoll consumes
`assay.retained_pack_diagnostic_sufficiency.v0` as a ceiling guard. Assay-Harness
still does not emit the carrier until a workflow needs retained-pack diagnostic
localization.

## Why This Is Banked

The July 2026 agent-harness frontier is moving from final-outcome scoring toward
trace-guided diagnosis and harness repair. HarnessFix shows the strongest nearby
pattern: failed trajectories are useful only when trace evidence can be normalized
enough to attribute failures to responsible trajectory steps and harness layers
before repair is attempted.

That frontier movement validates the finding, not the product timing. P47 is
therefore banked as a contract-ready DoR and explicitly held as a build until
there is demand for the state in a real reviewer workflow.

Assay-Harness already has a strong artifact contract for
`suite.evidence_pack.v0` and `suite.evidence_pack.v1`: path safety, digest
binding, projection-to-source coherence, provenance binding, and explicit
non-claims. That is necessary, but it is not the same predicate as diagnostic
localization.

P47 keeps those predicates separate if and when it is implemented:

- `evidence-pack verify` remains artifact-contract verification.
- Diagnostic sufficiency is an additional reviewer state over retained evidence.
- A valid pack may still be diagnostically insufficient or ambiguous.

## Build Gate

Do not implement this as Assay-Harness product surface merely because the lab
finding is true or because the SOTA frontier is moving. Implementation requires
at least one of:

- a named producer workflow in Assay-Harness that needs to emit retained-pack
  diagnostic localization for Plimsoll or another downstream verdict consumer;
- a real over-read incident where an artifact-valid pack was treated as a
  localized failure;
- an explicit workflow owner asking for retained-pack diagnostic localization.

Absent one of those, the correct state is: finding done, consumer contract
pinned, Assay-Harness producer build held.

## Consumer Contract Alignment

Plimsoll is the first consumer of this contract. It pins the current carrier
shape and guards these ceilings:

- schema: `assay.retained_pack_diagnostic_sufficiency.v0`;
- states: `diagnostic_localized`, `diagnostic_ambiguous`,
  `diagnostic_insufficient`, and `invalid`;
- ceilings: `step_layer_reason`, `artifact_contract`, and `none`;
- split fields: `failure_reason_classes` for localized failures and
  `diagnostic_reasons` for insufficiency, ambiguity, invalidity, and supported
  clean absence;
- `no_failure_observed` is an absence claim and is gated by source class;
- diagnostic reasons such as `source_bytes_missing` are invalid when relabelled
  as `failure_reason_classes`.

Consumer-side coverage boundary: Plimsoll can check the declared state, source
class, ceiling, and reason vocabulary. It does not recompute retained-layer
coverage from raw Harness state. Therefore an Assay-Harness producer must carry
coverage-completeness facts in the diagnostic carrier before clean absence or
localized failure is emitted. Without those facts, emit
`diagnostic_insufficient` with a diagnostic reason such as
`layer_coverage_not_complete`.

## Lab Finding

The private lab probe `retained-pack-diagnostic-sufficiency-2026-07` generated
15 fixture records and reproduced them with a clean-room implementation. The key
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

The follow-up vectors explicitly model the occurrence/absence asymmetry from
the source-class ceiling finding: a concrete failure localization is an
occurrence claim, while `no_failure_observed` is an absence claim and is gated
more strictly.

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

A **failure atom** is a distinct `(step_id, layer, reason_class)` tuple after
normalizing duplicate observations. Multiple observations of the same tuple are
one atom; distinct tuples are multiple atoms and therefore ambiguous unless a
later contract defines a deterministic dominance rule.

### Output

The layer returns:

```json
{
  "schema": "assay.retained_pack_diagnostic_sufficiency.v0",
  "status": "diagnostic_localized",
  "ceiling": "step_layer_reason",
  "source_class": "boundary_observed",
  "failure_reason_classes": ["ringbuf_drops_nonzero"],
  "diagnostic_reasons": [],
  "non_claims": [
    "artifact_valid_does_not_imply_repair",
    "diagnostic_localized_is_not_root_cause",
    "diagnostic_state_is_not_policy_approval",
    "diagnostic_state_is_not_provider_truth",
    "diagnostic_state_is_not_runtime_truth",
    "projection_is_not_source_of_truth"
  ]
}
```

### State Rules

State precedence is:

`invalid -> diagnostic_insufficient -> diagnostic_ambiguous -> diagnostic_localized`.

`diagnostic_insufficient` beats `diagnostic_ambiguous` because an inadequate
evidence class cannot carry a diagnostic claim at all. Ambiguity is evaluated
only after the retained evidence class is strong enough to carry localization.

1. Artifact-contract failure wins first:
   - malformed pack,
   - unsafe path,
   - digest mismatch,
   - projection-source coherence failure,
   - external evidence shape failure.

   Result: `invalid`.

2. A concrete failure can be `diagnostic_localized` only when all are true:
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

7. `no_failure_observed` is an absence claim. It is stricter than concrete
   failure localization and can be `diagnostic_localized` only when all are true:
   - raw source bytes are retained;
   - projections are not the only carrier of the clean state;
   - coverage is complete over every layer in the declared retained boundary;
   - each source class carrying the clean observation can carry absence for its
     layer.

   Projection-only, partial, or self-reported clean evidence is
   `diagnostic_insufficient`, not localized.

### Source Class x Layer Authority

The source class must have vantage over the layer whose diagnostic claim it is
carrying.

| Source class | May localize | Must not localize by itself |
|---|---|---|
| `kernel_observed` / boundary-observed kernel stream | kernel-layer failures and no-failure absence inside kernel coverage | policy, SDK, carrier-layer failures |
| `policy_observed` / policy-engine trace | policy-layer failures and policy-layer absence | kernel, SDK, carrier-layer failures |
| `sdk_self_reported` | SDK-layer facts that the SDK itself reports | kernel, policy, carrier-layer failures; boundary-wide absence |
| `carrier_observed` | carrier-layer failures and carrier-layer absence | kernel, policy, SDK-layer failures |
| projection-only source | no localization claim | all layer-localized occurrence and absence claims |

Cross-layer localization requires retained evidence from the relevant layer, not
just a projection or a neighboring layer's self-report.

## Reason Classes

The output keeps failure reasons separate from diagnostic-state reasons.
`failure_reason_classes` name what failed when a failure is localized.
`diagnostic_reasons` name why the pack is not localized or why the clean absence
claim is allowed.

Initial classes:

| Class | Field | State | Meaning |
|---|---|---|---|
| `no_failure_observed` | `diagnostic_reasons` | `diagnostic_localized` | Complete retained boundary has no failure atom and absence is source-class-supported. |
| `ringbuf_drops_nonzero` | `failure_reason_classes` | `diagnostic_localized` | Kernel observation layer reports dropped events. |
| `policy_decision_mismatch` | `failure_reason_classes` | `diagnostic_localized` | Policy layer contradicts the expected decision. |
| `source_bytes_missing` | `diagnostic_reasons` | `diagnostic_insufficient` | Pack has projection but not retained source bytes. |
| `projection_only` | `diagnostic_reasons` | `diagnostic_insufficient` | Localization would rely on a lossy projection. |
| `layer_coverage_not_complete` | `diagnostic_reasons` | `diagnostic_insufficient` | The implicated layer is not fully covered. |
| `absence_source_class_insufficient` | `diagnostic_reasons` | `diagnostic_insufficient` | Clean absence is carried by a source class that cannot support absence. |
| `self_reported_layer_cannot_localize` | `diagnostic_reasons` | `diagnostic_insufficient` | A self-reported source is being used outside its own layer. |
| `multiple_failure_candidates` | `diagnostic_reasons` | `diagnostic_ambiguous` | More than one distinct failure atom remains. |
| `missing_step_id` | `diagnostic_reasons` | `diagnostic_ambiguous` | Failure atom lacks step identity. |
| `missing_layer` | `diagnostic_reasons` | `diagnostic_ambiguous` | Failure atom lacks layer identity. |
| `missing_reason_class` | `diagnostic_reasons` | `diagnostic_ambiguous` | Failure atom lacks reason class. |

`failure_reason_classes` and `diagnostic_reasons` are disjoint vocabularies.
A producer must not place an insufficiency or ambiguity reason such as
`source_bytes_missing`, `projection_only`, or `multiple_failure_candidates` in
`failure_reason_classes`. Consumers are expected to reject that as malformed
because it would turn "cannot localize" into "localized failure."

## Ceilings

| State | Ceiling |
|---|---|
| `diagnostic_localized` | `step_layer_reason` |
| `diagnostic_ambiguous` | `artifact_contract` |
| `diagnostic_insufficient` | `artifact_contract` |
| `invalid` | `none` |

`artifact_contract` means the pack may verify as an artifact, but the retained
evidence does not support a single localized diagnostic conclusion.

## Build Gate Acceptance

If a producer build trigger appears, P47 is ready to implement only when these
are true:

- the diagnostic state machine is kept separate from `evidence-pack verify`;
- existing valid/invalid pack behavior and exit codes stay unchanged;
- fixtures include all four states: localized, ambiguous, insufficient, invalid;
- fixtures include a malformed carrier where a diagnostic reason is wrongly
  placed in `failure_reason_classes`;
- tests prove that an artifact-valid projection-only pack is not localized;
- tests prove that two plausible failure atoms are ambiguous, not insufficient;
- tests prove that partial layer coverage cannot localize a failure;
- tests prove that `no_failure_observed` is gated as an absence claim;
- tests prove that absence requires complete retained-boundary coverage in the
  carrier, not only an absence-capable source class;
- tests prove that self-reported clean evidence cannot carry boundary absence;
- tests prove that malformed/path/digest errors return invalid before diagnostic
  semantics run;
- rendered output carries the non-claims above;
- docs state that diagnostic sufficiency does not imply repair, root cause,
  policy approval, provider truth, runtime truth, or safety.

## Implementation Shelf

If the build gate fires, the recommended minimal implementation is:

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
- Private lab probe: `retained-pack-diagnostic-sufficiency-2026-07`, 15 vectors
  with clean-room reproduction.
