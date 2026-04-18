# Paused Approval Pattern — Field Presence / Absence Table

> Phase A deliverable per `PLAN P23A` section 9. Separates what the
> runtime observes from what Assay Harness derives, for the paused
> human-in-the-loop approval seam confirmed in P22
> ([openai/openai-agents-js#1177](https://github.com/openai/openai-agents-js/issues/1177)).
>
> This document is the honest mapping between raw SDK surfaces and the
> v1 pause-only canonical artifact. It does not claim transcript truth,
> session truth, or complete runtime continuation semantics.

## Scope

Only the paused-approval capture seam. Not the resumed decision
surface, not policy decisions, not process summary, not subagent
attribution.

## Source material

This table is derived from the live `harness/src/harness.ts` capture
path in this repo, which uses the OpenAI Agents JS SDK's
`RunState.getInterruptions()` plus `state.toString()` surfaces. The
SDK team confirmed this seam as intended in #1177.

## Observed (runtime-native)

Fields the SDK hands us directly at the pause boundary. These are
surfaced by the runtime, not synthesized by the harness.

| Pattern field                  | SDK source                                    | Type                  | Notes |
|--------------------------------|-----------------------------------------------|-----------------------|-------|
| `interruptions[i].tool_name`   | `RunToolApprovalItem.name`                    | `string`              | Confirmed stable accessor per #1177. |
| `interruptions[i].call_id_ref` | `RunToolApprovalItem.rawItem.call_id` (or `.id`) | `string`            | Not a public accessor; see caveat below. |
| `pause_reason`                 | Implicit from `interruptions.length > 0`      | literal `tool_approval` | Always this value for the confirmed seam. |
| `active_agent_ref` (optional)  | `Agent.name`                                  | `string`              | Weak reviewer aid, not a governance field. |

### `call_id_ref` caveat

The SDK team confirmed `RunToolApprovalItem.rawItem.call_id` is not a
normalized public accessor across all approval item variants
(FunctionCallItem, HostedToolCallItem, ComputerUseCallItem, ...). The
pattern tolerates `rawItem.call_id ?? rawItem.id` as the extraction
path. If the SDK later exposes a normalized public accessor, the
pattern simplifies. Until then, runtimes adopting the pattern must
document their extraction choice.

## Derived (harness-local)

Fields Assay Harness computes from runtime-supporting material. These
are explicitly **not** native runtime truth, per `PLAN P23A` section 6.

| Pattern field       | Derivation                                          | Notes |
|---------------------|-----------------------------------------------------|-------|
| `resume_state_ref`  | SHA-256 of `state.toString()` serialized output    | App-level fingerprint, not byte-stable across SDK versions. Documented explicitly in #1177. |
| `schema`            | Constant `assay.harness.approval-interruption.v1`  | Assay-owned contract. |
| `framework`         | Constant per runtime (e.g. `openai_agents_sdk`)    | Identifies which runtime produced the artifact. |
| `surface`           | Constant `tool_approval` in v1                      | Tied to the confirmed seam. |
| `timestamp`         | `Date.now()` at pause moment                        | Harness-side wall clock, not SDK timing. |

## Deliberately excluded (runtime surface we read but do not store)

Available on the SDK result/state but not kept in the pause-only
artifact. This matches `PLAN P23A` section 2 and section 5's "not
allowed in v1" list.

| SDK surface                              | Why read                                      | Why excluded |
|------------------------------------------|-----------------------------------------------|--------------|
| `RunResult.newItems`                     | Iterated for policy checks (lane-specific)   | Too broad for a pause-only canonical artifact. |
| `RunResult.rawResponses`                 | Not used                                      | Raw LLM responses; volatile. |
| `RunResult.finalOutput`                  | Returned to caller                            | Model output, not a governance signal. |
| `RunResult.history`                      | Not used                                      | Transcript truth out of scope (ADR-002). |
| `RunToolApprovalItem.rawItem.arguments`  | Hashed in richer lane variants                | Pattern v1 does not require argument capture. Richer lanes may add `arguments_hash` as an extension. |
| `RunState` full serialized blob          | Hashed for `resume_state_ref`                 | Raw state must not appear in the canonical artifact. |
| `conversationId`, `previousResponseId`   | Not used                                      | Provider-managed; not portable. |
| Tracing spans                            | Not used                                      | Vendor-specific; out of scope. |

## Extensions possible beyond pattern v1 (informational)

These fields are NOT part of pattern v1. They exist in richer
runtime-specific artifacts (e.g. `fixtures/valid.harness.json`) as
lane-specific additions. The pattern validator passes them through
silently when present, but the pattern's canonical minimum does not
require them.

- `interruptions[i].arguments_hash` — richer lanes that hash tool
  inputs for audit purposes.
- `policy_snapshot_hash` — lanes wired to a policy engine.
- `policy_decisions` — nested decision records for richer analysis.

Extensions beyond pattern v1 must not re-introduce anything on the
"not allowed in v1" list (resumed fields, raw state, transcripts, etc.).

## Hard forbidden in v1 artifacts (from `PLAN P23A` section 5)

- raw serialized state inline
- transcript history
- newItems
- session identifiers
- provider chaining fields
- resumed decision fields (`resumed`, `resume_decision`, etc.)
- `resume_nonce`
- `resumed_from_artifact_hash`

The pattern validator rejects any of these with an explicit marker.

## One-line summary

Observed: two fields per interruption plus pause signal; derived: one
content-hash anchor plus harness-owned envelope metadata; excluded: all
runtime history, state, and session surfaces; extensions possible
without claiming broader runtime truth.
