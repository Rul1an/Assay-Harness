# Field Presence Table

> Internal reference for the Assay-Harness outreach to `openai/openai-agents-js`.
> Shows which SDK fields we capture in the canonical harness artifact,
> which live in broader SDK surfaces we read but do not store,
> and which we deliberately exclude.

## Context

The harness builds one approval-interruption artifact per paused run.
It leans on `RunState.getInterruptions()` (returns `RunToolApprovalItem[]`)
and the serialized `RunState` (via `state.toString()`) as the minimal seam
for pause/resume governance.

SDK version: `@openai/agents` 0.8.3 / `@openai/agents-core` with
`SerializedRunState` schema version 1.8.

## Captured in canonical artifact

These fields appear in the harness artifact (`valid.harness.json`)
and flow through to Assay evidence (NDJSON).

| Field | Source in SDK | How we derive it |
|---|---|---|
| `interruptions[].tool_name` | `RunToolApprovalItem.rawItem.name` | Direct read |
| `interruptions[].tool_call_id` | `RunToolApprovalItem.rawItem.call_id` | Direct read |
| `interruptions[].arguments_hash` | `RunToolApprovalItem.rawItem.arguments` | SHA-256 of canonical JSON (we hash, never store raw args) |
| `resume_state_ref` | `RunState.toString()` | SHA-256 of serialized state string (content address, not raw state) |
| `pause_reason` | Implicit from `interruptions.length > 0` | Always `"tool_approval"` when interruptions exist |
| `active_agent_ref` | `Agent.name` | Direct read of agent name string |
| `policy_snapshot_hash` | `PolicyEngine.snapshotHash` | SHA-256 of policy YAML (harness-side, not SDK) |
| `resume_nonce` | `crypto.randomBytes(16)` | Harness-generated, binds approval decision to specific pause |
| `resumed.resume_state_ref` | Same as above | Echoed on resume to bind back to interruption |
| `resumed.resume_decision` | `RunState.approve()` / `RunState.reject()` | Harness records which path was taken |
| `resumed.policy_snapshot_hash` | `PolicyEngine.snapshotHash` | Checked for drift between pause and resume |
| `resumed.resume_nonce` | Same nonce from interruption | Must match to bind resume to the correct pause |

## Read from SDK but not stored

These fields are available on the SDK result/state objects.
We read them during the run but deliberately do not include them
in the canonical artifact.

| Field | SDK surface | Why we read it | Why we exclude it |
|---|---|---|---|
| `RunResult.newItems` | `result.newItems` | Iterate to find tool calls for policy checks | Contains full model output; too broad for bounded artifact |
| `RunResult.rawResponses` | `result.rawResponses` | Not used | Raw LLM responses; volatile, not governance-relevant |
| `RunResult.finalOutput` | `result.finalOutput` | Returned to caller as `HarnessResult.finalOutput` | Model output, not a governance signal |
| `RunResult.lastAgent` | `result.lastAgent` | Could be used for multi-agent tracking | Only `agent.name` is governance-relevant |
| `RunResult.lastResponseId` | `result.lastResponseId` | Not used | Provider-specific, not portable |
| `RunState` (full serialized) | `state.toString()` | Hashed for `resume_state_ref` | Raw state is opaque; we store only its content hash |
| `RunToolApprovalItem.rawItem.arguments` | Raw arguments string | Hashed for `arguments_hash` | Raw args may contain PII/secrets; hash is sufficient |
| `RunToolApprovalItem.agent` | Agent reference on the item | Not used (we use top-level agent ref) | Redundant with `active_agent_ref` |
| `RunResult.inputGuardrailResults` | Guardrail results | Not used | Guardrails are a separate concern |
| `RunResult.outputGuardrailResults` | Guardrail results | Not used | Guardrails are a separate concern |
| `RunState.$schemaVersion` | Serialized state schema version | Not explicitly tracked | Could be useful for compatibility; not yet needed |

## Deliberately excluded (will not capture)

These are available in the SDK but excluded by design.
See ADR-002 (no transcript truth) and ADR-003 (MCP bounded evidence).

| Category | What it covers | Why excluded |
|---|---|---|
| Transcript / conversation history | `RunResult.history`, `RunResult.output` | ADR-002: observed is not verified; transcript truth is out of scope |
| Full RunState blob | Complete serialized JSON of `RunState` | Contains model context, conversation turns, provider internals; too large and volatile |
| Session / conversation IDs | `conversationId`, `previousResponseId` | Provider-managed state; not portable across runtimes |
| Model reasoning | Chain-of-thought, `RunReasoningItem` | Volatile; policy must not depend on model reasoning |
| Tracing spans | `SerializedSpanType`, trace IDs | Vendor-specific tracing is out of scope (see Roadmap: will not do) |
| MCP server internals | Full MCP protocol messages | ADR-003: bounded evidence only; we capture tool name/args/decision, not protocol details |
| Guardrail details | Input/output/tool guardrail results | Separate governance concern; could be a future evidence lane |
| Provider-specific fields | `providerData` on items | Not portable; defeats runtime-agnostic evidence goal |

## The seam we lean on

In summary, the harness treats two SDK surfaces as its external-consumer seam:

1. **`RunToolApprovalItem[]`** from `getInterruptions()`: gives us tool name, call ID, and arguments per paused tool call.
2. **`RunState`** serialization + `approve()`/`reject()`: gives us a content-addressable state ref and the resume mechanism.

Everything else we need (policy decisions, nonces, hashes) is harness-side.

## SDK team confirmation (openai/openai-agents-js#1177)

The SDK team confirmed this is the intended minimal seam for external consumers today.
Key points from that confirmation that shape our design:

- **Prefer `RunToolApprovalItem.name` and `.arguments`** over reaching into `rawItem` for those fields. The harness now uses these stable accessors.
- **No normalized public `call_id` accessor yet** across all approval item variants. We fall back to `rawItem.call_id ?? rawItem.id` and will adopt a public accessor if/when the SDK exposes one.
- **Stability contract for `RunState.toString()`**: guaranteed to resume via `fromString()`, NOT byte-stable across SDK versions. Our `resume_state_ref` (SHA-256 of the serialized string) is therefore an **app-level fingerprint**, not a portable cross-version wire hash. External consumers that need byte-stable identity across SDK upgrades should derive their own anchor from pre-resume state.
- **Resume preconditions**: the original top-level agent graph must be reconstructable at resume time, and agent names must be unique across handoffs and `agent.asTool()` graphs (the SDK uses agent names to rehydrate the graph). If resuming alongside a session, keep the same session.
