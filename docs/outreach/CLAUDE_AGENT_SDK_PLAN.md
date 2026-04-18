# Claude Agent SDK Outreach Plan (internal)

> Evaluation document. No code, no post. Portfolio position: cold /
> evaluating until explicit go. Covers target scoping, seam selection,
> channel norms, phased plan, and risks specific to this target.

## Grounding findings

Before writing a plan, I verified the publicly observable shape of the
target. Findings that shape the plan:

**Two SDK repos, issues only, no Discussions.** `anthropics/claude-agent-sdk-python`
(~6.4k stars) and `anthropics/claude-agent-sdk-typescript` (~1.3k stars).
Both have Discussions disabled. Issues is the only public channel. Per
strategy criterion 6, the channel is live but constrained: the post style
must match issue norms, not Discussion norms.

**Maintainer feedback loop is via commits, not prose.** Scanning the last
100+ issue comments on the Python repo shows maintainer accounts
(`qing-ant`, `jsham042`, `km-anthropic`) engaging primarily through PRs
and commit-linked closes, not through verbal seam-validation responses.
This is a materially different feedback pattern from the JS SDK lane
(`openai/openai-agents-js#1177`), where `seratch` wrote a full prose
response. Do not expect "yes this is the intended seam" as a reply here.
Expect either a commit that changes something, silence, or a label like
`planned` / `wontfix` / `duplicate`.

**The approval seam is `can_use_tool` (Python) / equivalent (TS).** It is
a per-call callback invoked before tool execution, returning
allow / deny with an optional reason or `updatedInput`. Confirmed in the
current Python README and in active issues (#816, #381, #469).

**Our Deep Agents tool_call_id question is already answered here.** Issue
#376 closed 2026-03-28 explicitly exposed `tool_use_id` in the
`can_use_tool` callback. That means the correlation friction we hit on
Deep Agents does not exist on Claude Agent SDK. We cannot ask that
question. Good news, but it removes one obvious post angle.

**Seam-adjacent active friction points (inventory, for context only):**

- #816 open — `permissionDecisionReason` from `PreToolUse` hooks not forwarded to `can_use_tool` callback.
- #381 open — `updatedInput` in `PreToolUse` hooks without requiring `permissionDecision`.
- #469 open — control-protocol mismatch bug between CLI and `can_use_tool`.
- #304 closed — long-running tool approval (historical reference).
- #330 closed — no mechanism to reject-and-explain (historical, likely resolved).

Overlap with any of these would reduce signal. The plan must pick an
angle that none of these cover.

## Seam selection

The Claude Agent SDK's `can_use_tool` is a **per-call policy gate**, not
a pause plus continuation. This is structurally different from the pause
seams on the JS Agents SDK (interruption plus `RunState`) and Deep Agents
(HITL middleware plus `StateSnapshot`).

Consequence: we do not emit a `pause-v1` style artifact here. We emit a
`policy-decision-v1` style artifact, one per `can_use_tool` invocation.
Fields we would need per decision:

- `tool_name`
- `tool_use_id` (already exposed, matches #376)
- `arguments_hash` (harness-side hash, raw args never in the artifact)
- `decision` (allow / deny)
- `decision_reason` (optional, bounded string)
- `policy_snapshot_hash` (harness-side)
- `timestamp`

This is strictly smaller than pause-v1. No interruptions array, no
continuation anchor. One event per call.

This also means the portfolio gets a second evidence family rather than a
third pause lane. That is a feature, not a bug: it tests the portability
of the Assay evidence model against a genuinely different interrupt
shape, which strategy criterion 7 recommends.

## Artifact family decision

The mapper currently has one top-level schema
(`assay.harness.approval-interruption.v1`) with `policy_decisions` as a
nested array. For the Claude Agent SDK adapter we have two options:

**Option A: new top-level schema `assay.harness.policy-decision.v1`.**
One canonical outward artifact per `can_use_tool` call. Mirrors pause-v1
structurally (framework, surface, timestamp, policy_snapshot_hash), but
with a single decision instead of an interruptions array. Requires mapper
extension parallel to what we did for Deep Agents.

**Option B: reuse the existing pause-v1 envelope with a single
"interruption" entry.** Structurally incorrect (there is no pause here,
no continuation), but reuses existing code. Reject on honesty grounds.

**Pick: Option A.** The adapter emits a new artifact family. The mapper
parameterization we already landed in `ccc3af5` gives us a template for
how to extend cleanly without restructuring.

## Channel-norm analysis

The issue norm on these repos is:

- Title prefix: `feat:`, `[BUG]`, `[Doc]`, plain title, or `Feature Request:`.
- Body: environment block, exact reproduction, expected vs actual,
  version numbers. Long bodies with runnable scripts get traction
  (#826 reproduction block is the archetype).
- Nothing resembling a "is this the intended approach" discussion post.
- Community cross-comments are common and welcomed. Maintainers may read
  those before responding with a fix.

Implication: any Assay Harness post here must look like a well-formed
feature request or a precise question tied to a concrete limitation the
adapter encountered. Not a seam-validation narrative. That narrative
belongs in our own docs, not in their issue tracker.

## The specific question (options, not final pick)

Three candidate post angles that are not covered by existing issues:

**Angle 1: decision-finalized callback.**
Today `can_use_tool` returns allow/deny. Afterwards the tool may
succeed, error, or be skipped. An external audit consumer wants to
close the decision-to-outcome loop without correlating via
`tool_use_id` across multiple event types. Question: is there an
intended surface for a post-execution signal tied to the earlier
`can_use_tool` decision, or is correlation via `tool_use_id` the
intended path?

This overlaps partially with #381 (updatedInput) and #816
(permissionDecisionReason), so it needs careful framing to not be a
duplicate. Risk: medium.

**Angle 2: decision correlation across parallel tool calls.**
When two tool calls fire in parallel (or across subagents), the probe
for Deep Agents hit this. On Claude Agent SDK, `tool_use_id` solves
it. But the `policy_snapshot_hash` we emit on our side is per-consumer,
not per-SDK-call. Question: is there a stable way for consumers to
know a `can_use_tool` decision applied to a specific
permission-config state as loaded by the CLI at that moment?

This is real but possibly too harness-internal to be a good post. Risk:
high. Likely answer is "not our concern, use your own snapshot."

**Angle 3: a smaller documentation-shaped question.**
After building the adapter, the post asks a crisp documentation-shaped
question about a behavior that was underspecified and the adapter had
to infer. For example, "does `can_use_tool` fire on auto-approved
allowed_tools, or only on tools that fall through to
`permission_mode`?" This is a factual question answerable by a
maintainer in one line, and it would naturally fit the repo norm.

Risk: lowest. This is probably the right first angle. The question
itself is smaller than the OpenAI and Deep Agents questions, but that
is fine: small, factual, answerable in one line matches the Claude
Agent SDK channel norm.

Decision on the specific angle is **deferred** until after the probe.
The probe will surface the actual friction the adapter hits. Post
whichever friction the adapter naturally exposes, not whichever friction
we speculated in advance.

## Phased plan

This mirrors the Deep Agents sequence but adapted for the per-call policy
seam and the issue-only channel.

### Phase 0: evaluation (this document)

Already done. Portfolio position: cold / evaluating. No commit beyond
this file.

### Phase 1: prep card (`CLAUDE_AGENT_SDK_PREP.md`)

Analogous to `DEEPAGENTS_PREP.md` but with:

- explicit acknowledgement of issue-only channel and commit-driven feedback loop
- new artifact family `assay.harness.policy-decision.v1` shape
- explicit acknowledgement that seam validation will not come in prose
- non-goals: no pause semantics, no MCP-specific behavior, no subagent
  hierarchy, no `PreToolUse` hook integration, no settings.json reading,
  no CLI permission modes beyond allow/deny

Committed internally as a review gate. No outreach yet.

### Phase 2: mapper smoke-check

Can `mapper/map_to_assay.py` absorb a `policy-decision-v1` top-level
schema without restructuring? The mapper is already parameterized for
framework allow-set and for event construction. A new schema requires:

- an allow-list for the top-level schema string (currently hardcoded to
  `approval-interruption.v1`)
- a new top-level shape (decision instead of interruptions array)
- a new event builder for the policy-decision event (the existing
  `policy-decision` event builder is nested-style, different call site)

The smoke-check produces findings analogous to
`DEEPAGENTS_MAPPER_SMOKECHECK.md`. If the answer is "small
parameterization works," we land that in a small commit before probe.
If the answer is "needs restructuring," we pause and recut.

### Phase 3: probe

Build a tiny `probes/claude-agent-sdk/` that:

- installs `claude-agent-sdk` in a throwaway venv
- invokes one `can_use_tool` callback with one tool
- captures the exact callback arguments (`tool_name`, `tool_input`,
  `tool_use_id`, any context fields)
- writes `capture.json` and `FINDINGS.md`

Three probe questions (parallel to the Deep Agents probe template):

- Q1. Does `can_use_tool` carry everything the adapter needs at the
  call site, or does the adapter have to correlate against a separate
  event stream to produce `policy-decision-v1`?
- Q2. Can the adapter emit the artifact from inside the callback
  synchronously, or does it need to defer to a post-callback hook?
- Q3. Does the callback receive enough context to compute
  `policy_snapshot_hash` correlation, or is that purely harness-side?

Throwaway deliverable only. No adapter directory.

### Phase 4: tiny adapter

If probe is green, build `adapters/claude_agent_sdk/`:

- `agent.py` with one approval-required tool
- `evidence.py` with `build_policy_decision_artifact(...)`
- `run.py` entry point
- `tests/test_evidence.py` pure-unit tests
- `tests/test_roundtrip.py` runtime test, skipped without SDK installed
- `README.md` with hard non-goals
- fixtures `valid.policy-decision.claude_agent_sdk.json`,
  one failure, two or three malformed

All 61+ existing tests remain green. Adapter tests are additive.

### Phase 5: single concrete issue post

Title format must match repo norm. Candidates:

- `Question: external-consumer policy-decision seam around can_use_tool`
- `Question: does can_use_tool fire on auto-approved allowed_tools?`
- `feat: post-decision outcome signal tied to can_use_tool tool_use_id`

Body matches repo norm: short context, evidence-backed, one specific
question, link to our adapter. Underclaim verbatim.

Post on the Python repo, not the TS one. Stars and issue volume suggest
the Python repo is the primary conversation surface.

## Reply guide (adapted for this channel)

The maintainer feedback pattern on this repo is commits, not comments.
Reply guide must account for that.

**If a maintainer responds verbally.** Bedank, stel hoogstens één
volgvraag, sluit eigen thread af met wat we in de adapter documenteren.

**If a commit closes the issue without comment.** Read the commit diff,
update the adapter README if behaviour changed, update the portfolio
status to confirmed-by-commit.

**If nothing happens for 14 days.** The lane is internally-usable /
externally-soft. Do not escalate. Do not cross-link to the OpenAI or
Deep Agents posts. Document the silence as a valid outcome.

**If someone marks it duplicate.** Accept and close. Our adapter still
works; the upstream conversation is happening on the duplicate.

## Risks

**Risk 1: the post looks like product marketing.** The repo is full of
bug reports. An "external-consumer governance seam" post could read as
out-of-place self-promotion. Mitigation: title is a question or
`feat:`, body stays technical, Assay Harness only named in a single
closing line.

**Risk 2: overlap with existing open issues.** #816, #381, #469 cover
adjacent territory. Mitigation: read each thread fully before posting,
explicitly cross-link in the body if relevant, avoid re-raising any
point already made.

**Risk 3: no verbal answer ever.** Given the channel norm, this is
likely. Mitigation: the lane is still strong internally if the adapter
and mapper are clean, and the public post is a legitimate anchor even
without reply. Portfolio discipline treats silence as a valid outcome.

**Risk 4: adapter exposes a finding that contradicts the prep card.**
Probable. Then the probe and prep both need recut before phase 4. This
is the whole point of the phased sequence.

**Risk 5: maintainer responds with "this belongs upstream in Claude
Code, not the SDK."** Then the lane is channel-blocked (criterion 6),
and we either find an upstream surface or accept the lane as
procedurally-blocked. Do not chase.

## Portfolio position

| Lane | Status | Next trigger |
|---|---|---|
| OpenAI Agents JS (#1177) | confirmed | none expected, lane closed |
| Deep Agents (#2798) | active | upstream reply or 14-day silence |
| Claude Agent SDK | cold / evaluating | Deep Agents reply arrives, and Roel signs off on this plan |

## Go / no-go before phase 1

- [ ] This evaluation document reviewed and approved.
- [ ] Deep Agents lane has either a reply or is at 14-day silence.
- [ ] No appetite to handle both in parallel; sequential only.
- [ ] Comfortable with "no verbal response" as a likely outcome here.
- [ ] Python is the primary target (not TS), agreed.

## One-line summary

Claude Agent SDK is a harness-shaped target with a per-call
`can_use_tool` policy seam, a different evidence artifact family than
our existing pause-v1 lanes, an issues-only channel with a commit-driven
feedback loop, and three candidate post angles that must be chosen
after the probe surfaces the actual friction.
