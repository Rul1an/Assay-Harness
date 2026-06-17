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

### `assay-harness runner cross-runtime report`

Tier 3A — consumer of `assay.runner.cross_runtime_diff.v0`. Reads a precomputed diff JSON file and projects it into reviewer markdown or JSON. The Runner side (`Rul1an/assay`) owns the cross-runtime semantics; Harness validates the frozen contract shape and renders. **Informational only**: the report verb does NOT translate regressions into exit 6. The future Tier 3C `gate` verb (deferred) will add gating exit codes on top of the same parser.

| Outcome | Exit Code |
|---------|-----------|
| Diff parses, contract-shape valid (regardless of whether `added` is non-empty) | 0 |
| `--diff <path>` missing or file does not exist | 2 |
| Diff JSON malformed, schema string mismatch, surface category shape invalid, tampered `binding_ids`/`policy_outcomes` out-of-scope marker, missing `sdk_metadata` sides, or other v0 contract-shape violation | 3 |
| Unknown `runner cross-runtime` subcommand | 2 |

> v0 cross-runtime regression policy (rendered in the report status line and `regression_summary` section): added entries on any of `surface.{filesystem_paths,network_endpoints,process_execs,mcp_tools,policy_decisions}` mark the report as `RUNNER CROSS-RUNTIME REGRESSION`. Removed entries are reported but never blocking. **`sdk_metadata` changes are reported as side-band runtime provenance and are NEVER treated as a capability regression.** Binding-id and policy-outcome comparison are out of scope for v0 cross-runtime diff per the Runner side contract; Harness flags any tampered marker as `artifact_contract` (3).

> Tier 3B (archive-pair convenience wrapper) is NOT implemented yet — kept as demo recipe / future option, not as core CLI surface, to avoid Harness becoming a second producer of cross-runtime semantics.

### `assay-harness runner cross-runtime gate`

Tier 3C — CI-blocking gate over the same precomputed `assay.runner.cross_runtime_diff.v0` artefact that `report` consumes. No new semantic logic; only different exit translation. Reuses the strict v0 clean-schema validator from Tier 3A.

| Outcome | Exit Code |
|---------|-----------|
| Clean diff, no added capability surface (regardless of `removed` entries, SDK metadata changes, or notes) | 0 |
| Any added entry in `surface.{filesystem_paths,network_endpoints,process_execs,mcp_tools,policy_decisions}` | 6 |
| Diff JSON malformed, schema mismatch, contract-shape violation, tampered out-of-scope marker, etc. | 3 |
| `--diff` missing or file not found | 2 |
| Unknown `runner cross-runtime` subcommand | 2 |

> The gate verb is **exit-focused**: stdout stays clean for CI logs; a one-line status (`[success]` / `[regression]` / `[artifact_contract]`) goes to stderr. Callers that want full reviewer output should use `runner cross-runtime report` instead.

> Same v0 cross-runtime policy as `report`: removed entries never block, SDK metadata changes are side-band only and NEVER trigger exit 6, tampered out-of-scope markers fail validation with exit 3.

### `assay-harness carrier supply-chain`

Consume an `assay.supply_chain_conformance.v0` carrier, validate its frozen
shape, gate on the producer-owned `policy_result`, and project Markdown / JUnit /
SARIF. The gate surfaces the producer's verdict; it does not re-derive one from
the dimensions.

| Outcome | Exit Code |
|---------|-----------|
| Carrier valid and `policy_result` is `pass` | 0 |
| Carrier valid but `policy_result` is `fail` or `incomplete` (incomplete is never clean) | 6 |
| Carrier malformed, wrong/unknown schema id, unknown `CheckStatus`, unknown `policy_result`, or contract-shape violation | 3 |
| `--carrier` missing, or the carrier file is not found | 2 |
| Markdown/JUnit/SARIF projection write fails (with `--out-dir`) | 7 |

### `assay-harness carrier render-safety`

Consume an `assay.render_safety_conformance.v0` carrier, validate the frozen
shape, gate on the producer-reported per-sink facts, and project Markdown / JUnit /
SARIF.

| Outcome | Exit Code |
|---------|-----------|
| Carrier valid and every sink is clean (no raw secret/PII/control leak, redaction-before-truncation, benign-preserved) | 0 |
| Carrier valid but any sink leaked, truncated before redacting, or over-redacted benign output | 6 |
| Carrier malformed, wrong/unknown schema id, or contract-shape violation | 3 |
| `--carrier` missing, or the carrier file is not found | 2 |
| Markdown/JUnit/SARIF projection write fails (with `--out-dir`) | 7 |

### `assay-harness carrier token-passthrough`

Consume an `assay.token_passthrough_conformance.v0` carrier, validate the frozen
shape, gate on the producer-reported per-channel facts, and project Markdown /
JUnit / SARIF.

| Outcome | Exit Code |
|---------|-----------|
| Carrier valid and no checked outbound channel leaked or reported `pass=false` | 0 |
| Carrier valid but a checked outbound channel reports `leak_count > 0` or `pass=false` | 6 |
| Carrier malformed, wrong/unknown schema id, or contract-shape violation | 3 |
| `--carrier` missing, or the carrier file is not found | 2 |
| Markdown/JUnit/SARIF projection write fails (with `--out-dir`) | 7 |

### `assay-harness carrier enforcement-health`

Consume an `assay.enforcement_health.v1` carrier (Landlock TCP-connect domain),
validate the frozen shape, gate on the producer-reported status, and project
Markdown / JUnit / SARIF. This is the carrier-local honest-state gate; the
enforcement-truth review (policy-aware approval over the outcome) is a separate step.

| Outcome | Exit Code |
|---------|-----------|
| Carrier valid and `status` is `active` (ruleset applied; a real-block probe, when present, is surfaced) | 0 |
| Carrier valid but `status` is `failed` (enforcement requested but not installed) | 6 |
| Carrier malformed, wrong/unknown schema id, unknown status, or contract-shape violation | 3 |
| `--carrier` missing, file not found, or `--format` not `markdown`/`json` | 2 |
| Markdown/JUnit/SARIF projection write fails (with `--out-dir`) | 7 |

### `assay-harness carrier inventory`

Describe an `assay.mcp_server_inventory.v0` carrier (Tier-2B, descriptive). Validate
the frozen shape and project a reviewer-facing Markdown summary of scanner coverage
and observed servers. This is descriptive, not a gate: a valid inventory exits 0
regardless of contents.

| Outcome | Exit Code |
|---------|-----------|
| Carrier valid (any inventory contents) | 0 |
| Carrier malformed, wrong/unknown schema id, or unknown coverage state | 3 |
| `--carrier` missing, file not found, or `--format` not `markdown`/`json` | 2 |
| Markdown projection write fails (with `--out-dir`) | 7 |

### `assay-harness carrier check`

Detect carrier contract drift: dispatch any conformance carrier by its `schema` id
to the registered adapter and report whether the Harness recognises the contract
and the carrier matches its frozen shape. This is the schema / shape dimension
only; the per-carrier gate verdict is the schema-specific verb's job (a well-formed
carrier that reports a leak is contract-valid here and fails its own gate verb).

| Outcome | Exit Code |
|---------|-----------|
| Schema id is registered and the carrier matches the frozen shape | 0 |
| Unknown/unregistered schema id, missing or non-string `schema`, malformed JSON, or a recognised schema whose shape has drifted | 3 |
| `--carrier` missing, the file is not found, or `--format` is not `markdown`/`json` | 2 |

### `assay-harness suite check` / `assay-harness suite matrix`

The suite compatibility matrix (`suite.compatibility.v0`) is a suite-contract
artifact, not a producer carrier and not a Plimsoll review. `suite check` gates the
matrix on its own internal consistency (never on organization policy); `suite matrix`
projects it. It is a VSA-shaped compatibility summary, not a SLSA VSA. Each row splits
the proof into `harness_consumption` (Harness can validate/gate/project the carrier
shape) and `end_to_end` (released Assay binary emitted it and Harness consumed it in a
hosted run). `--against-registry` adds drift detection vs the live carrier registry.

| Outcome | Exit Code |
|---------|-----------|
| Matrix valid and internally consistent (incl. recomputed digest match); with `--against-registry`, no drift | 0 |
| Malformed JSON, wrong/missing `schema`, unknown enum state (`support_mode`/`backing`/proof state), digest mismatch, an `end_to_end: "proven"` row without `hosted_run` + `artifact_digest`, or (registry mode) a registered carrier with no row / a row with no adapter / a stale verb / a mode mismatch | 3 |
| `--matrix` missing, the file is not found, or `--format` is not `markdown`/`json` | 2 |

An `end_to_end: "declared"` row is **not** a failure; it is visible pending-proof. There
is no `6` here: the matrix reports no producer-owned not-clean gate, it describes the
suite contract.

### `assay-harness evidence-pack create` / `assay-harness evidence-pack verify`

The Evidence Pack (`suite.evidence_pack.v0`) is a deterministic, digest-bound bundle of a
proven carrier recipe. It binds raw Assay carrier bytes, the Harness Markdown projection,
the suite matrix, and the recipe provenance; it creates no new evidence and approves no
policy. `verify` is strict and does artifact-contract only (the carrier gate already ran).

| Outcome | Exit Code |
|---------|-----------|
| Pack valid: the three v0 evidence roles present (each once) + the Markdown projection, manifest digest + sidecar match, file digests match, path-safe, every projection resolves to a source, provenance is a hermetic success, metadata cross-check holds, and the coherence invariant holds (carrier bytes == matrix proven row == provenance, on the same artifact + proof) | 0 |
| Malformed manifest shape, missing/duplicated evidence role, unreadable / wrong schema / digest mismatch, file missing / file-digest mismatch / unlisted file (or unlisted symlink), unsafe path (`..` / absolute / symlink / escapes root) / duplicate path, projection without a resolvable source, provenance invalid or not a hermetic success, metadata or coherence mismatch, or `optional_private_reviews available:true` (unsupported in v0) | 3 |
| Missing pack dir or bad CLI args | 2 |
| (`create` only) projection/manifest write failure, or the freshly built pack fails self-verify | 7 |

`created_at` is informational and excluded from the manifest digest, so identical evidence
yields the same pack identity. No `6`.

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
