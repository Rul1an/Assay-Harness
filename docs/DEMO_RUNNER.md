# Demo: Runner archive validation, regression, and cross-runtime gating

This walkthrough shows what Assay-Harness does with Assay-Runner output, end to end, using **synthetic fixtures** that you can regenerate locally. No live eBPF, no delegated host, no real workload — just enough to see what each verb produces.

If you are evaluating whether Harness's Runner support would fit your CI, this is the document that answers "what would a regression actually look like in PR review and in CI exit codes?".

## What this demo is not

- Not an install guide for Assay-Runner. Runner lives in [`Rul1an/assay`](https://github.com/Rul1an/assay) as an internal subsystem; this demo only consumes archives and diffs Runner produces.
- Not a benchmark or performance demo. The fixtures are deterministic and tiny.
- Not a claim that two runtimes are semantically equivalent. The cross-runtime diff in v0 carries explicit non-claims; the demo renders them as-is.

## Set up

Build the harness binary and the fixtures.

```bash
cd harness
npm install
npm run build

cd ..
node examples/runner/build-fixtures.mjs
```

`build-fixtures.mjs` writes four files into `examples/runner/`:

| File | Used by |
|---|---|
| `clean.tar.gz` | `verify-runner`, `runner compare` (baseline) |
| `regression.tar.gz` | `runner compare` (candidate with added capability surface) |
| `cross-runtime-diff-clean.json` | `runner cross-runtime report`/`gate`, clean case |
| `cross-runtime-diff-regression.json` | `runner cross-runtime report`/`gate`, regression case |

The script uses the same in-file ustar+gzip writer pattern as the test suite and only depends on `node:crypto` and `node:zlib`. No external npm install needed.

Each run is short. All examples below use the relative path `examples/runner/...` from the repo root.

## 1 — `verify-runner` on a single archive

Confirms one Runner archive parses, that its manifest + per-file digests are valid, and that its observation-health is clean.

```bash
node harness/dist/cli.js verify-runner examples/runner/clean.tar.gz
```

Output:

```
# Runner Archive Verification

**Archive:** `examples/runner/clean.tar.gz`
**Recognised:** yes
**Manifest valid:** yes
**Run id:** `run_demo_clean`
**Honest health:** passed
```

Exit: `0`.

## 2 — `runner compare` on two archives (Tier 2A capability-surface diff)

Compares two Tier-1-clean archives on their `capability-surface.json` payload. The `regression.tar.gz` fixture adds one filesystem path, one MCP tool, and one `allow:*` policy decision on top of the clean baseline — all three are regression triggers under the v0 policy.

```bash
node harness/dist/cli.js runner compare \
  --baseline examples/runner/clean.tar.gz \
  --candidate examples/runner/regression.tar.gz
```

Output (abbreviated):

```
# Runner Capability-Surface Diff (Tier 2A)

**Status:** RUNNER CAPABILITY REGRESSION
**Summary:** RUNNER CAPABILITY REGRESSION: filesystem_paths_added:1, mcp_tools_added:1, policy_allow_decisions_added:1

- Baseline run id: `run_demo_clean`
- Candidate run id: `run_demo_regression`

## Filesystem Paths

Added:
- `/tmp/demo/work/output.txt`

## MCP Tools

Added:
- `write_file`

## Policy Decisions

Added:
- `allow:write_file`

## Regression Reasons

- `filesystem_paths_added:1`
- `mcp_tools_added:1`
- `policy_allow_decisions_added:1`

> v0 policy: added `filesystem_paths`, `network_endpoints`, `process_execs`,
> and `mcp_tools` are regressions. For `policy_decisions`, only new `allow:*`
> entries block; new `deny:*` entries are recorded as report-only changes.

## Per-Layer Projection (Tier 2B — reviewer UX, not a gate)
...
```

Exit: `6` (`regression`).

The Tier-2B per-layer projection appears below the diff. It is explanatory only — its content does not change the Tier-2A regression flag.

## 3 — `runner cross-runtime report` (Tier 3A)

Renders a precomputed `assay.runner.cross_runtime_diff.v0` artefact as a reviewer report. The `clean.json` fixture has no added capability surface, so the report status is `OK` even though `sdk_metadata` differs between the two runtimes (the v0 contract treats SDK metadata as side-band provenance only).

```bash
node harness/dist/cli.js runner cross-runtime report \
  --diff examples/runner/cross-runtime-diff-clean.json
```

Output (abbreviated):

```
# Runner Cross-Runtime Diff Report (Tier 3A)

**Status:** OK
**Diff file:** `examples/runner/cross-runtime-diff-clean.json`

> Tier 3A is a consumer of `assay.runner.cross_runtime_diff.v0`. It does NOT
> compute its own cross-runtime diff and does NOT claim two runtimes are
> semantically equivalent. The Runner side owns the cross-runtime semantics.

- Base runtime: `s5_openai_agents` (run id `run_demo_openai_agents`)
- Head runtime: `gemini_google_genai` (run id `run_demo_gemini_google_genai`)
- Diff status (Runner-side): `clean`

## SDK Metadata (side-band only)

- Base: `@openai/agents` @ `0.11.4`
- Head: `google-genai` @ `2.6.0`
> SDK metadata change is reported as runtime provenance and is NEVER
> treated as a capability regression in v0.

## Non-Claims (carried from the diff)

- `cross_runtime_no_acceptability_judgment`
- `cross_runtime_no_declared_capability_input`
- `cross_runtime_no_derived_binding_identity`
- `cross_runtime_no_filename_semantic_equivalence`
- `cross_runtime_no_sdk_capability_equivalence`
...
```

Exit: `0`. `report` is **informational only** — even when the diff carries a regression signal, the verb exits 0. The regression signal becomes a CI exit code in step 4.

## 4 — `runner cross-runtime gate` (Tier 3C)

Same parser as `report`, different exit-code translation. Stdout stays clean for CI logs; status goes to stderr.

### Clean case → exit 0

```bash
node harness/dist/cli.js runner cross-runtime gate \
  --diff examples/runner/cross-runtime-diff-clean.json
echo "exit=$?"
```

Output (stderr):

```
[success] runner cross-runtime gate: no added capability surface
```

```
exit=0
```

### Regression case → exit 6

The `regression.json` fixture has one added MCP tool on the gemini side and one added filesystem path. Cross-runtime v0 treats added entries on any of the five categories as a regression.

```bash
node harness/dist/cli.js runner cross-runtime gate \
  --diff examples/runner/cross-runtime-diff-regression.json
echo "exit=$?"
```

Output (stderr):

```
[regression] runner cross-runtime gate: added capability surface (filesystem_paths=1,mcp_tools=1)
```

```
exit=6
```

That `exit=6` is what CI consumes. The matching `report` invocation against the same file would still exit `0` because `report` is informational; `gate` is the CI decision.

## What this catches in practice

The same shape of regression — newly visible capability surface compared to a previous run — is what would surface when an agent's PR introduces new runtime behaviour:

- A code change introduces a new file open → `filesystem_paths_added`
- A dependency upgrade enables a new MCP tool → `mcp_tools_added`
- A policy edit widens what is allowed → `policy_allow_decisions_added`
- The same agent prompt produces a different capability surface on a different runtime → cross-runtime regression

Harness does not measure any of this directly. Runner produces the measurement; Harness validates, projects, and gates.

## What is deliberately out of scope here

- **No live eBPF run.** All Runner archives are produced by the demo script. Real measurement requires a Linux/eBPF delegated host configured on the Runner side ([`Rul1an/assay`](https://github.com/Rul1an/assay)).
- **No archive-pair → cross-runtime diff convenience wrapper** (Tier 3B). The cross-runtime diff JSONs in this demo are precomputed. A future demo recipe may call Runner-side projection from a pair of archives; that work is deferred until there is real two-runtime workflow demand.
- **No SDK-equivalence claim.** The cross-runtime diff's `non_claims` field carries five explicit boundaries, including `cross_runtime_no_sdk_capability_equivalence`. Harness renders these but never overrides them.

## Exit-code reference (Runner verbs only)

| Verb | Clean outcome | Capability regression | Contract violation | Missing input |
|---|---|---|---|---|
| `verify-runner` | 0 | n/a (single archive) | 3 | 2 |
| `compare` (Runner mode) | 0 | 6 | 3 | 2 |
| `runner compare` (Tier-2 strict) | 0 | 6 | 3 | 2 |
| `runner cross-runtime report` | 0 | 0 (informational) | 3 | 2 |
| `runner cross-runtime gate` | 0 | 6 | 3 | 2 |

Full per-verb tables, including the contrast between `compare` Runner-mode (softer routing) and `runner compare` (strict Tier-2), are in [`docs/contracts/EXIT_CODES.md`](contracts/EXIT_CODES.md).

## Where to go next

- `docs/contracts/EXIT_CODES.md` — stable exit-code contract per verb
- `CHANGELOG.md` — what landed in `v0.5.0` (Tier 1 + 2A + 2B) and `v0.6.0` (Tier 3A + 3C)
- [`Rul1an/assay`](https://github.com/Rul1an/assay) — where Runner archives and cross-runtime diffs come from
- [`Rul1an/Assay-Harness#58`](https://github.com/Rul1an/Assay-Harness/issues/58) — the product-options inventory that scoped this work
