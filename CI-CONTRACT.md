# CI Contract: Rul1an/Assay-Harness

Draft status: review contract before workflow implementation.

`Rul1an/Assay-Harness` is the public recipe, gate, and report layer for
canonical Assay artifacts. It is not a runtime, capture engine, or second source
of artifact semantics. The CI contract must therefore preserve the existing
fixture/golden-output coverage, prove compatibility with released Assay shapes,
and keep public docs/examples honest about what the harness consumes and reports.

This contract is a diff from today's repository state. The first rule is no
required-coverage regressions: existing useful gates should stay required unless
this file is updated with a clear replacement.

## 0. As-Is Inventory

Repository state observed on 2026-06-11:

- Visibility: public.
- Default branch: `main`.
- Languages: TypeScript/JavaScript, Python.
- Workflows:
  - `.github/workflows/harness-ci.yml`
  - `.github/workflows/release.yml`
  - `.github/workflows/sbom.yml`
  - `.github/workflows/zizmor.yml`
- Reusable local action: `.github/actions/setup-node-harness/action.yml`.
- Workflow posture already present:
  - workflow-level `permissions: {}` in the main workflows;
  - per-job permissions;
  - `persist-credentials: false`;
  - PR concurrency in `harness-ci.yml`;
  - `zizmor` required-check no-op behavior for unrelated PRs;
  - SBOM generation on main;
  - release artifact generation and build provenance attestation on tags.
- Current action pinning: third-party actions use version tags such as
  `actions/checkout@v6.0.2`, `actions/setup-python@v6`,
  `actions/setup-node@v6`, `actions/upload-artifact@v7`,
  `github/codeql-action/upload-sarif@v4.36.0`, and
  `actions/attest-build-provenance@v4`, not commit SHAs.
- Main CI required-shape jobs in `harness-ci.yml`:
  - `Node Tests + Type Check`
  - `Contract Validation`
  - `Golden Contract Tests`
  - `Hardening Tests`
  - `Policy Validation`
  - `Verify Evidence`
  - `Regression Gate`
  - `Evidence Export`
  - manual `Assay Release Compatibility Recipes`
- TypeScript package: `harness/package.json`, package `assay-harness`,
  version `0.8.0`, scripts for build, typecheck, tests, verify, and harness
  run.
- Python utilities and tests:
  - `mapper/map_to_assay.py`
  - `ci/emit_*.py`
  - adapter/probe code under `adapters/`, `patterns/`, and `probes/`
  - Python unittest suites under `tests/`
- Public artifacts and fixtures:
  - `fixtures/*.harness.json`
  - `fixtures/*.assay.ndjson`
  - adapter fixtures under `fixtures/claude_agent_sdk/` and
    `fixtures/deepagents/`
  - examples under `examples/`
  - emitted JUnit/SARIF paths in CI
- Dependency automation: `.github/dependabot.yml` for npm and GitHub Actions.
- CI notes already document why job consolidation, broad path filtering, and
  release npm caching were not chosen.
- Required branch-protection contexts: to be confirmed from a live PR through
  GitHub's checks API before settings are changed.

No target workflow should downgrade this inventory unless the contract is
updated with an explicit rationale.

## 1. Required PR Checks

Required checks must be cheap, stable, and relevant to public contract drift.
They should preserve cross-language fixture coverage rather than path-filtering
away the exact regressions this repo exists to catch.

### Existing Harness Contract Coverage

Keep these behaviors required:

- Node build/typecheck and Node tests.
- Mapping valid and failure fixtures to golden NDJSON output.
- Malformed fixture rejection.
- Python golden contract tests.
- Python hardening tests.
- Policy decisions for allowed, denied, and approval-required tools.
- Evidence verification over valid and failure fixtures.
- Regression compare output and exit behavior.
- JUnit/SARIF evidence export shape.
- SARIF upload tolerance where code-scanning upload is unavailable.

Do not split or path-filter these checks in a way that lets TypeScript changes
skip Python contract tests, or Python mapper changes skip TypeScript consumer
tests. This repository's value is the language boundary.

### Assay Compatibility

Keep the release-binary compatibility recipe workflow available through
`workflow_dispatch`, and treat it as the proving lane for a specific Assay
release tag.

Follow-up target:

- Add a scheduled compatibility canary against the latest supported Assay release
  line after the release-binary download path has a stable cost and failure
  profile.
- Keep Assay `main` compatibility non-blocking and scheduled/manual only. It is
  useful early warning, not a PR gate.

### Workflow And Action Hygiene

Keep `zizmor` required for workflow-relevant changes and weekly drift. Add or
confirm:

- `actionlint` for all workflow files.
- `shellcheck` for shell blocks in workflows and local action shell blocks,
  either through actionlint integration or an explicit extractor.
- `timeout-minutes` on every job.
- Per-job `permissions` only; workflow-level default remains `permissions: {}`.
- `persist-credentials: false` on all checkouts unless a job explicitly writes.
- If release or SBOM workflows keep using tag-pinned third-party actions, the
  contract should record that choice; otherwise move high-trust release actions
  toward commit-SHA pins in an implementation PR.

### Public Artifact Sanitization Guard

Add a required public-artifact sanitization check for docs, examples, fixtures,
SARIF/JUnit generation code, and release notes.

Hard rule:

- The sensitive vocabulary list must not be present in this public repository
  and must not be printed in CI logs.

Acceptable implementation patterns:

- Compare normalized tokens or n-grams against hashed entries supplied from a
  private source.
- Run plaintext sensitive-list checks only in trusted private contexts where logs
  are not public and untrusted PR code cannot read the list.
- On fork PRs, run only the public-safe structural portion.

Logging contract:

- Report only counts and locations, for example `3 matches in README.md:42`.
- Never print matched text.
- Never print the sensitive term, phrase, or unhashed denylist entry.
- Treat printing the matched term as a CI bug and a sanitization failure.

The guard is a backstop, not a guarantee. Human sanitization review remains
primary because fixed matchers miss variants and context.

### Claims And Boundary Guard

Add a lightweight required check for public wording in changed docs/examples:

- Claims should name the consumed artifact or fixture shape.
- Claims should name whether the check is informational or gating.
- Claims should state degradation/non-claim when evidence cannot support a
  stronger statement.
- Docs must not imply that Harness captures runtime behavior, performs live
  provider verification, owns Assay artifact semantics, or upgrades evidence
  beyond the observed source.

This guard can start as a checklist-backed script plus tests over known public
docs. It should not block legitimate examples that explicitly state their
boundary.

## 2. Scheduled Checks

Scheduled checks are for ecosystem drift and compatibility warning, not for
ordinary PR cost.

- Existing weekly `zizmor` drift canary.
- OpenSSF Scorecard for public supply-chain posture.
- OSV-Scanner for npm, Python, and GitHub Actions dependency surfaces.
- CodeQL or equivalent code scanning for TypeScript/JavaScript, Python, and
  workflow glue if GitHub default setup is not enabled.
- Scheduled SBOM remains useful on main.
- Optional scheduled Assay release compatibility against the latest supported
  release.
- Optional non-blocking Assay `main` compatibility canary.

Do not schedule:

- Live model/provider runs.
- Self-hosted runner requirements.
- Broad matrix expansion without a measured failure class.

## 3. Release-Only Checks

Release-only checks should preserve the existing artifact and provenance posture.

Keep:

- Release tests before artifact generation.
- Evidence artifact generation for JUnit, SARIF, and golden fixtures.
- GitHub release creation/update through the GitHub CLI.
- Build provenance attestation for release artifacts.
- Release workflow's explicit no-cache choice unless a future contract update
  changes the supply-chain tradeoff.

Add or confirm:

- Release notes/examples validate against current CLI inputs and outputs.
- SBOM attached to releases if the release starts distributing package artifacts
  beyond generated evidence fixtures.
- Floating tag policy if this repo later adopts floating major/minor tags.

Current release boundary:

- Attestations apply to the generated release artifacts in this repository.
- They do not prove Assay runtime truth, live provider behavior, or correctness
  beyond the emitted artifact subject and workflow boundary.

## 4. Manual Checks

Manual workflows are acceptable for checks that are useful but not routinely
needed:

- Assay release compatibility for a specific input tag.
- Compatibility against Assay `main`.
- Expanded adapter/probe suites that require optional SDKs.
- Regeneration of large example artifacts.

Manual workflow requirements:

- Inputs must be read through environment variables or otherwise avoid template
  injection.
- Downloaded release assets must be checksum-verified.
- Any generated public artifacts must pass sanitization before publication or
  release attachment.

## 5. Non-Goals And Non-Claims

Non-goals:

- No fuzzing by default.
- No live model/provider dependency in required PR checks.
- No self-hosted runner dependency.
- No broad OS matrix by default.
- No path-filtered skip that hides cross-language fixture regressions.
- No second artifact semantics layer beside Assay.

Allowed language:

- "Recipe, gate, and report layer."
- "Composes released Assay artifact shapes."
- "Emits JUnit/SARIF projections."
- "Gates a fixture-backed regression."
- "Reports observed support and degradation."

Disallowed without explicit boundary:

- Claims that Harness captures runtime effects.
- Claims that Harness verifies live provider behavior.
- Claims that Harness proves compliance.
- Claims that Harness replaces Assay verification.
- Claims that attestation changes observed support.

The sanitization guard is separate from these claim-boundary rules. It protects
private strategy vocabulary from appearing in public artifacts and must do so
without reprinting protected vocabulary.

## 6. Required Context Names

Branch protection is enforced by exact check context names, not by this file.
Before making any branch-protection changes:

1. Open a draft PR that implements the workflows.
2. Query the live check runs for that PR.
3. Copy the exact check names into this section.
4. Treat future job renames as breaking changes because they can silently
   un-gate protected branches.

Proposed required context groups:

- Existing `Harness CI` contract jobs.
- Existing `Audit workflow security` check.
- Public artifact sanitization.
- Action/workflow lint.
- Claims and boundary guard.

Exact names: to be filled from a live implementation PR.

## 7. Target Workflow Files

Expected target workflow set:

- `.github/workflows/harness-ci.yml` kept and tightened, not removed.
- `.github/workflows/zizmor.yml` kept.
- `.github/workflows/sbom.yml` kept.
- `.github/workflows/release.yml` kept.
- `.github/workflows/action-lint.yml` if actionlint/shellcheck are not folded
  into the existing zizmor workflow.
- `.github/workflows/sanitize.yml` for public-artifact sanitization.
- `.github/workflows/claims-boundary.yml` for public wording and non-claim
  checks, unless folded into sanitization.
- `.github/workflows/compatibility-canary.yml` only if scheduled Assay release
  compatibility is promoted after review.

Implementation should happen in small follow-up PRs after this contract is
reviewed.
