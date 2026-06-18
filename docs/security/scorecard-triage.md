# OpenSSF Scorecard — finding triage

This repository runs OpenSSF Scorecard and OSV on a schedule and surfaces the
results in the GitHub code-scanning ("Security") tab. Not every finding is a code
defect: some are real action items, some are structural to a young, single-maintainer
project, and some are governance items best documented so they don't read as unresolved
week after week.

This note records how each finding is handled, so the security surface is either clean
or explicitly explained. It does **not** suppress findings wholesale, fabricate reviews,
manufacture activity to move a score, or claim a badge that has not been earned.

## Summary

| Finding | Status | Action | Claim |
|---|---|---|---|
| Vulnerabilities (#84) + OSV `GHSA-g7r4-m6w7-qqqr`, `GHSA-gv7w-rqvm-qjhr`, `CVE-2026-45736` | Fixed | Dependabot bumps on `main`: `ws`→8.21.0, `hono`→4.12.26, `esbuild`→0.28.1 | dependency advisories resolved; `npm audit` clean |
| Pinned-Dependencies (36×) | Fixed | SHA-pinned every GitHub-owned action across the CI/release/sbom/zizmor/sanitize workflows | all actions pinned by commit hash |
| Branch-Protection (#50) | Addressed | `main` requires a PR + the `Node Tests + Type Check` status check, blocks force-push/deletion, enforced for admins; 0 required approvals to preserve solo self-merge | protection enabled, not maximal — see Code-Review |
| Fuzzing (#85) | Actionable | Randomized property test against the Evidence Pack verifier (the untrusted-input surface); see `docs/security/fuzzing.md` | real coverage of the hostile-input path, not a score flip |
| Code-Review (#81) | Structural | Accepted single-maintainer limitation; all changes still go through PRs (branch protection blocks direct pushes) | reviews are not manufactured; two-party review needs a second maintainer |
| Maintained (#82) | Age-gated | None — Scorecard flags repositories under 90 days old; it re-evaluates automatically as the repo ages | no code change; not influenced by artificial activity |
| OpenSSF Best Practices badge (#83) | Deferred | Apply for the badge later, once the security basics are stable | governance/paperwork, no code impact |
| Harness self-scan `HARNESS-A001` / `HARNESS-R001` (#36/#37) | Resolved | Fixture-derived SARIF is kept as a CI artifact and no longer uploaded to code-scanning; the fixture and its detection stay, with a CI assertion that both rule IDs fire on `fixtures/valid.assay.ndjson` | test evidence stays in CI output; the repo alert surface carries only actionable repository risk |

## Notes

**Code-Review (#81) and Maintained (#82)** are structural to a young, single-maintainer
repository. No commits, issues, or reviews are fabricated to influence either score.
Branch protection now routes every change through a PR, which is the honest part of the
Code-Review story that is actually within our control.

**Fuzzing (#85)** is the one finding treated as a real technical follow-up. The first
target is the Evidence Pack verifier's manifest and path handling. Scorecard detects
fuzzer integrations such as OSS-Fuzz, so a property test may not register on the check —
that is an accepted trade-off in favour of covering the actual untrusted-input surface.

**Harness self-scan (#36/#37)** are the harness's own findings on a valid sample trace.
They demonstrate the harness working, not a weakness in this repository, so they no longer
belong on the repository alert surface. `harness-ci` still generates the SARIF and retains it
as a CI artifact, and a CI assertion proves both rule IDs still fire on the fixture, but the
SARIF is no longer uploaded to code-scanning. The two existing alerts are dismissed as
"used in test" with a comment pointing to this note; they will not recur.
