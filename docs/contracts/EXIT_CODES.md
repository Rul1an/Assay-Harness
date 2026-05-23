# Exit Codes — Stable Contract

> **Version:** 0.2.0
> **Status:** frozen for semver

All CLI commands use the following exit code taxonomy. Downstream CI and
tooling may depend on these codes for routing, alerting, and failure
classification.

## Exit Code Table

| Code | Class | Meaning |
|------|-------|---------|
| 0 | `success` | All checks passed, no regressions, no denials |
| 1 | `policy_violation` | At least one tool call was denied by policy |
| 2 | `config_error` | Missing or invalid config, policy file, or input |
| 3 | `artifact_contract` | Evidence artifact fails contract validation |
| 4 | `mapper_failure` | Evidence mapper rejected input or produced invalid output |
| 5 | `resume_error` | Resume flow failed (stale state, double resume, hash mismatch) |
| 6 | `regression` | Baseline comparison found regressions |
| 7 | `ci_formatter` | JUnit/SARIF generation failed |

## Command-Specific Behavior

### `assay-harness run`

| Outcome | Exit Code |
|---------|-----------|
| Clean run, no denials | 0 |
| Run completed but denials present | 1 |
| Policy file missing or invalid | 2 |
| Resume failed | 5 |

### `assay-harness verify`

| Outcome | Exit Code |
|---------|-----------|
| All events valid | 0 |
| Envelope contract failures | 3 |
| Config error (file missing) | 2 |

### `assay-harness compare`

| Outcome | Exit Code |
|---------|-----------|
| No regressions (NDJSON mode) | 0 |
| Regressions found (NDJSON mode) | 6 |
| Both inputs are Runner archives, Tier-1 validation clean | 0 |
| Either Runner archive fails manifest/digest validation (Tier 1) | 3 |
| Either Runner archive fails honest-health gate without `--allow-degraded` | 6 |
| Input mode mismatch (one NDJSON, one Runner archive) | 2 |
| Unrecognised input shape | 2 |
| Config error (file missing) | 2 |

> Runner-archive mode in `compare` is Tier 1 only (recognise + manifest/digest
> verification + honest-health gate). Structural diff across the two archives
> is Tier 2 and is not implemented in this version. See
> `Rul1an/Assay-Harness#58` and the design references in
> `Rul1an/assay/docs/reference/runner/`.

### `assay-harness verify-runner`

| Outcome | Exit Code |
|---------|-----------|
| Archive recognised, manifest + digests valid, honest-health clean | 0 |
| Manifest schema mismatch, digest mismatch, missing manifest, or unreadable archive | 3 |
| Honest-health degraded and `--allow-degraded` is not set | 6 |
| Archive file missing or unreadable as a config input | 2 |

### `assay-harness policy`

| Outcome | Exit Code |
|---------|-----------|
| Decision is allow or require_approval | 0 |
| Decision is deny | 1 |
| Config error | 2 |

## Stability Promise

These exit codes are part of the v0.2.0 contract. Changes require:

- a new minor version bump
- explicit CHANGELOG entry
- golden test update
- ADR documenting the rationale
