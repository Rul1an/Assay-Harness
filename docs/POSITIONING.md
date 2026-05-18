# Positioning — Assay-Harness

> **Status:** canonical positioning reference
> **Last updated:** 2026-05-18
> **Scope:** defines what Assay-Harness is, what it is not, and the boundary
> with `assay-action` and `assay`. Not a roadmap; the 90-day plan below is
> indicative sequencing, not a feature commitment.

## One-liner

**Public (the hook):**

> Assay-Harness — the verified last mile from Assay evidence to reviewable CI
> artifacts.

**Subtitle (what it does):**

> Runs released Assay recipes, produces verify-before-diff comparisons, and
> projects them into the artifacts, job summaries, and JUnit your CI already
> shows.

**Canonical architecture sentence (internal):**

> `assay-action` *wraps* released Assay capabilities. `Assay-Harness`
> *composes* released Assay capabilities. Neither defines new artifact
> semantics.

**The triad (one-breath explanation):**

> Assay = the compiler. `assay-action` = the button. `Assay-Harness` = the
> playbook.

"Projection" is an internal architecture word — it does not appear in the
public line, which says "reviewable CI artifacts". "Verified" stays explicit:
the defensible core is *verified* projection, not projection. Without it the
layer reads as glue.

## The category claim

As of mid-2026, "harness" publicly means agent-runtime / execution
scaffolding — the agent loop and runtime orchestration. Presenting
Assay-Harness externally as "a harness" places it in that crowded category
(signed-receipt and agent-runtime vendors) and invites the wrong comparison.

This document positions Assay-Harness explicitly *outside* that category. It
is a CI/review layer. It is not a runtime, not an eval runner, not a gateway,
not a control plane.

## Do / Don't

**Assay-Harness MUST:**

- host and version released recipes
- orchestrate baseline/candidate chains
- run trust-basis verify-before-diff / gate / report flows
- retain raw diff JSON as a canonical artifact
- project results into Markdown / JUnit / job summaries
- provide release-binary proof runs

**Assay-Harness MUST NOT:**

- semantically interpret Promptfoo / OpenFeature / CycloneDX / LiveKit
  payloads itself
- add new receipt or claim semantics
- become a runtime/agent harness, an eval runner, or a dashboard
- invent a second policy or trust model beside Assay

All artifact semantics live in Assay-core. Assay-Harness composes; it does not
define.

## Boundary with `assay-action` and `assay`

| Layer | Role | Grain |
|---|---|---|
| `assay` | The compiler. Compiles policy, produces evidence bundles, owns receipt/bundle/Trust-Basis/claim semantics. | engine |
| `assay-action` | The button. Smallest GitHub-native entry point: make Assay available, run one stable CLI flow, upload artifacts / SARIF / PR summary. Thin wrapper, no family logic, no baseline strategy. | single-step |
| `Assay-Harness` | The playbook. Recipes, baseline ↔ candidate chains, diff / gate / report, proof chains. Composition, no semantics. | multi-step |

**Hard rule:** neither `assay-action` nor `Assay-Harness` defines new artifact
semantics.

**Which to reach for:**

- Use `assay-action` to run the standard Assay flow inside a GitHub Actions
  workflow and get a PR summary / SARIF / report.
- Use `Assay-Harness` to run released recipes, compare baseline vs candidate,
  obtain raw diff JSON plus Markdown/JUnit, and keep a reproducible proof
  chain.

## Adoption shape

The adoption mistake would be to sell Harness as something you must adopt
*beside* Assay, with worldview buy-in. The correct social form is: easy to
touch, no buy-in required.

The first adoption surface is not "use Assay-Harness as your governance
layer". It is:

- drop this recipe into your repo
- get raw diff JSON + Markdown/JUnit
- keep your existing runner

This is why a Promptfoo-first wedge comes first: Promptfoo already shows how
JSON/JSONL, HTML, and JUnit work as CI outputs. Harness lands on top of that,
it does not fight it.

## 90-day sequencing

Indicative sequencing, not a feature commitment.

**Phase 1 — day 0–30: tighten the smallest wedge (Promptfoo-first).**
One recipe, one verify-before-diff artifact, one Markdown/JUnit projection.
The recipe must show the *delta* over Promptfoo's own JUnit: Promptfoo reports
whether the test passed; receipt + Harness diff reports what changed between
releases and proves it against a released binary. No delta means no wedge.
Output: search-intent doc, released recipe, proof pack.

**Phase 2 — day 30–60: compatibility surface.**
Harness should feel like something used *alongside*
Promptfoo/OpenFeature/CycloneDX, not instead of them. Compatibility ledger,
proof packs, one canonical diff contract, zero family-specific
interpretation.

**Phase 3 — day 60–90: release proofs first-class.**
Per release: a proof pack, released links, recipe validated against the
released Assay binary. This makes Harness citable — "it runs on a release
binary and you can see exactly what comes out." Naming checkpoint: by this
point there is data on whether the `Harness` name causes real friction
(search confusion, miscategorisation in issues); decide a possible rename
then, on evidence.

**Phase 4 — after day 90: seeding (gated, not a campaign).**
Third-party seeding is *dependent on* the Phase 3 proof pack — without "it
runs on a released binary", no seed comment is credible. At most one
repo-native proof plus one or two contextual follow-ups. No campaign.
