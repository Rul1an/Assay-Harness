# Release Plan — Assay Harness 0.2.0

> **Status:** released as `v0.2.0`
> **Published:** 2026-04-27
> **Purpose:** Companion Harness release for the Assay v3.6.0
> evidence-portability line. Assay defines and produces the artifact contracts;
> Assay Harness consumes those contracts operationally in CI.

---

## Framing

**Suggested lead:**

> Assay Harness v0.2.0 adds the operational CI layer above Assay Trust Basis
> artifacts: a thin Trust Basis regression gate, Markdown/JUnit projections for
> the raw Assay diff contract, and a runnable Promptfoo receipt pipeline recipe.

Keep the boundary explicit:

- Assay owns evidence import, receipt reduction, bundle verification, Trust
  Basis generation, and Trust Basis diff semantics.
- Assay Harness owns orchestration, exit-code mapping, artifact persistence, and
  CI-friendly projections.
- Harness does not parse Promptfoo JSONL, inspect Assay receipt payloads, or
  decide whether an eval outcome is true.

---

## Version Advice: 0.2.0

This is a pre-1.0 minor release because it adds user-facing Harness CLI
surfaces:

| Area | Why it fits 0.2.0 |
|------|-------------------|
| CLI | Adds `assay-harness trust-basis gate` and `assay-harness trust-basis report`. |
| CI artifacts | Adds raw diff preservation plus Markdown and JUnit projections. |
| Cross-repo contract | Adds fixtures proving Harness consumes real Assay diff output. |
| Recipe | Adds a runnable Promptfoo receipt pipeline over existing contracts. |

Do not reuse Assay's `3.6.0` semver. This repository has its own package and
GitHub Release line.

---

## Pre-Release Verification

- [ ] `npm ci` in `harness/`
- [ ] `npm test` in `harness/`
- [ ] `npm run typecheck` in `harness/`
- [ ] `python3 -m unittest tests.test_contracts -v`
- [ ] `python3 -m unittest tests.test_hardening -v`
- [ ] `git diff --check`
- [ ] `harness/package.json`, `harness/package-lock.json`, README, roadmap, and
  changelog agree on `0.2.0`.

---

## Release Notes Outline

### Users

- Use `assay-harness trust-basis gate` to gate canonical Trust Basis artifacts
  using Assay's diff contract.
- Use `assay-harness trust-basis report` to project the raw
  `assay.trust-basis.diff.v1` JSON into Markdown and JUnit for CI review.
- Run `demo/run-promptfoo-receipt-pipeline.sh` with an Assay binary that includes
  the v3.6.0 Promptfoo receipt importer and Trust Basis diff command.

### Integrators

- Preserve the raw Assay diff JSON as the canonical artifact.
- Treat Markdown, JUnit, and job summaries as projections only.
- Keep Promptfoo semantics outside Harness. The recipe is downstream
  orchestration over existing surfaces, not an integration claim.

### What This Release Is Not

- Not an Assay release.
- Not an npm publication claim.
- Not Promptfoo support, endorsement, or partnership.
- Not a new Trust Basis schema or claim policy.
- Not SARIF output for Trust Basis diffs.

---

## Tagging

After the release-prep PR is merged and checks pass:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml)
and creates the GitHub Release artifacts.
