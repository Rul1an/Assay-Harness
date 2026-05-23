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

Mode dispatch is by file extension (`.ndjson`/`.jsonl` → NDJSON path, `.tar.gz`/`.tgz` → Runner-archive Tier-1 path). A corrupted or non-Runner `.tar.gz` is still routed through the Runner-archive validator so the structural failure surfaces as `artifact_contract (3)` rather than being misclassified as `config_error (2)`.

| Outcome | Exit Code |
|---------|-----------|
| No regressions (NDJSON mode) | 0 |
| Regressions found (NDJSON mode) | 6 |
| Both inputs are Runner archives, Tier-1 validation clean | 0 |
| Either Runner archive fails strict H1 validation: archive unreadable, manifest missing/malformed, manifest schema mismatch, manifest run_id invalid, manifest entry malformed, manifest digest format invalid, file missing, file bytes mismatch, file digest mismatch, or archive contains a file not listed in the manifest | 3 |
| Either Runner archive fails the honest-health gate (without `--allow-degraded`): kernel layer degraded, ring-buffer drops non-zero, cgroup correlation not clean, correlation status not clean, observation-health missing or malformed, correlation-report missing or malformed | 6 |
| Input mode mismatch (one NDJSON-extension, one `.tar.gz`-extension) | 2 |
| Unrecognised input shape (extension not recognised) | 2 |
| Config error (file missing) | 2 |

> Runner-archive mode in `compare` is Tier 1 only (recognise + manifest/digest
> verification + honest-health gate). Structural diff across the two archives
> is Tier 2 and is not implemented in this version. See
> `Rul1an/Assay-Harness#58` and the design references in
> `Rul1an/assay/docs/reference/runner/`.

> `--allow-degraded` bypasses only measurement-health reasons
> (`kernel_layer_not_complete`, `ringbuf_drops_nonzero`,
> `cgroup_correlation_not_clean`, `correlation_status_not_clean`). It does
> NOT bypass structural reasons such as archive-not-recognised, manifest
> invalid, or observation-health / correlation-report missing or malformed —
> those remain failures regardless.

### `assay-harness runner compare`

Tier 2A — capability-surface diff over two Tier-1-clean Runner archives. Validates both archives, applies the honest-health gate, then diffs `capability-surface.json`. This verb's purpose is the Tier-2 diff; any Tier-1-not-clean input is treated as an input/contract failure, not a regression.

| Outcome | Exit Code |
|---------|-----------|
| Both archives Tier-1 clean, no capability-surface regressions | 0 |
| Capability-surface regression: added `filesystem_paths`, `network_endpoints`, `process_execs`, `mcp_tools`, or new `allow:*` `policy_decisions` | 6 |
| Either archive fails strict H1 (manifest/digest invalid, archive unreadable, file not in manifest) | 3 |
| Either archive fails honest-health (without `--allow-degraded`): degraded kernel layer, ring-buffer drops, non-clean cgroup correlation, non-clean correlation status | 3 |
| Either archive is missing or has malformed `observation-health.json` / `correlation-report.json` | 3 |
| Either archive is missing or has malformed `capability-surface.json` (incl. shape-invalid: non-array category fields, non-string elements) | 3 |
| Either input is not a Runner archive by extension (`.tar.gz` / `.tgz`) | 2 |
| Archive file missing as a config input | 2 |
| Unknown `runner` subcommand | 2 |

> **Routing rule:** `runner compare` exits **3 (artifact_contract)** for *any* Tier-1-not-clean input — including honest-health degradation and missing or malformed artifacts. This is intentionally stricter than the generic `compare` verb's Runner-mode routing (which exits 6 for honest-health). The verb is explicitly the Tier-2 diff path; if Tier 1 is not clean, the precondition for the verb is not met and there is no Tier-2 result to report. Callers that want softer routing should use `compare` or `verify-runner` instead.

> v0 regression policy:
> - added `filesystem_paths`, `network_endpoints`, `process_execs`, `mcp_tools` → regression
> - added `policy_decisions` of the form `allow:*` → regression
> - added `policy_decisions` of the form `deny:*` → **report-only** (recorded in the diff's `added` list, but does not trip the regression flag — typically reflects newly visible blocked behaviour rather than added capability surface)
> - removed entries → reported but never a regression
>
> Tier 2A diffs the `capability-surface.json` payload only and is what controls the regression flag. Per-layer reviewer projections (Tier 2B) live alongside the Tier-2A diff in the output, summarise per-layer event counts + event-type histograms (and SDK tool churn), and surface the `self_reported` caveat on the SDK layer per the v0 contract. Tier 2B is **explanatory only**: it does NOT change the Tier-2A regression flag, does NOT add new exit codes, and does NOT introduce new gating semantics.

### `assay-harness verify-runner`

| Outcome | Exit Code |
|---------|-----------|
| Archive recognised, manifest + digests valid, honest-health clean | 0 |
| Any strict H1 manifest/digest failure: archive unreadable, manifest missing/malformed, manifest schema mismatch, manifest run_id invalid, manifest entry malformed, manifest digest format invalid (missing `sha256:` prefix), file missing, file bytes mismatch, file digest mismatch, or archive contains a file not listed in the manifest | 3 |
| Honest-health failure (without `--allow-degraded`): kernel layer degraded, ring-buffer drops non-zero, cgroup correlation not clean, correlation status not clean, observation-health missing or malformed, correlation-report missing or malformed | 6 |
| Archive file missing or unreadable as a config input | 2 |

> Observation-health and correlation-report JSON parse / schema mismatches do
> NOT trip `artifact_contract` (3) on their own. They leave the corresponding
> payload undefined, which the honest-health gate then catches as a
> structural reason that `--allow-degraded` cannot bypass. Result: exit
> `regression` (6) without `--allow-degraded`, and still exit 6 even with
> `--allow-degraded` because the reason is structural rather than
> measurement-health.

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
