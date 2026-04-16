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
| No regressions | 0 |
| Regressions found | 6 |
| Config error (file missing) | 2 |

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
