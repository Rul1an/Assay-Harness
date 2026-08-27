# Assay Compatibility

Assay Harness consumes Assay artifacts. It does not define receipt semantics,
Trust Basis claim semantics, or Trust Card schemas itself.

## Current Compatibility Target

Assay Harness consumes the Trust Basis contract line first proven on released
Assay `v3.8.0` and re-measured at Assay `v5.4.0` peel
`bbb5e7fe4b03bc6160d18e2966e75a7586c062ef`. That peel still emits Trust Basis
diff schema `assay.trust-basis.diff.v1`, Trust Card `schema_version = 5`, ten
frozen claims, and eval / decision / inventory receipt families. The consumer
version comes from the sibling `package.json` of `--matrix`; do not restate it
by hand.

The v5.4.0 GitHub tag is mutable. Contract revalidation binds the published
Linux CLI bytes `assay-v5.4.0-x86_64-unknown-linux-gnu.tar.gz` at
`sha256:352cd390dc59fb5adacecae5adf51976419f18ae50918f8f1504952869e94ad3`, not
the tag string.

The suite matrix `generated` object is a derived projection, not a present-tense
recommendation. `generated.last_verified_assay` is the highest explicitly recorded
`proof.assay_version` in the suite matrix. That is not necessarily the highest
underlying Assay version used by every proof — a recipe row can prove a later
binary without carrying `proof.assay_version` — and it is not a supported range
or a claim that current Assay is covered.
`generated.assay_default` is a deprecated alias of `last_verified_assay`.
`generated.verified_on` is the retained historical projection date
(`2026-06-17`) and may predate later row runs; it is never regenerated from the
current clock.

> **Upstream note (measured, 2026-08-27):** the Trust Basis contract surface
> still holds at the v5.4.0 peel. Honest producer gaps remain:
> `render_safety_conformance.v0` has no released one-shot CLI emitter;
> `token_passthrough_conformance.v0` remains live-proxy-only.
> Landlock `assay sandbox --probe-enforcement` is the unprivileged
> `assay.enforcement_health.v1` emitter (schema id measured with an underscore
> at the peel writer). A Darwin skip is not a pass, and an unavailable
> Linux/Landlock host is not a clean result. The probe does not claim universal host support.
> The earlier `requires_privileged_runtime` premise is
> stale for this Landlock path. The hosted x86_64 `assay.enforcement_health.v1`
> proof is folded from `Harness CI` run `33080407473` (carrier JSON digest, not
> the Actions zip and not the published tarball). `generated.verified_on` stays
> the historical `2026-06-17`. This is not an aarch64 measurement.

| Contract | Expected surface |
|---|---|
| Trust Basis diff | `assay.trust-basis.diff.v1` |
| Trust Card schema | `schema_version = 5` |
| Trust Basis claim count | 10 frozen claims |
| Receipt families visible in Trust Basis | eval, decision, inventory |
| Receipt schema registry | Assay-owned; Harness does not validate receipt payloads |

Assay `v3.8.0` remains the minimum exact tag that opened this Trust Basis
compatibility line. The suite matrix last-verified Assay pin is derived from
recorded proofs and is not a current-support claim. The enforcement-health
carrier row is now `end_to_end=proven` at Assay `v5.4.0` on hosted
`ubuntu-latest`; render-safety and token-passthrough remain declared producer
gaps. The local-asset probe is not itself the hosted proof.

## Release-Binary Proof

PR2b adds `harness/scripts/probe-v54-enforcement-health.mjs`: a digest-bound
local-asset path that verifies `sha256` before extraction and runs
`assay sandbox --enforce --enforce-net --probe-enforcement --enforcement-health <out> --policy <policy> -- true`.
It parses exactly one `assay.enforcement_health.v1` record. There is no
network fallback, no source build, and no best-effort parse. Extraction also
applies fixed expanded-byte and entry ceilings (32 MiB / 8 entries) with
symlink/hardlink refusal; that is a resource ceiling, not a claim the published
v5.4.0 archive is malicious or oversized. This is not a hosted Linux runtime
proof on Darwin. The frozen probe script changed for those bounds, so a later
promotion needs a fresh hosted proof.

The `Harness CI` workflow has a manual `workflow_dispatch` compatibility job.
It downloads the selected Assay release binary, verifies its checksum, and runs
the Promptfoo, OpenFeature, and CycloneDX recipes against that binary.

The default dispatch input is:

```text
assay_version = v3.27.0
```

This job is the release-binary compatibility proof rail. The proof-before-release
gate for Harness `v0.3.1` passed against Assay `v3.8.0` in
[`Harness CI` run 25105149901](https://github.com/Rul1an/Assay-Harness/actions/runs/25105149901)
before the `v0.3.1` tag. The same recipes were verified after the Assay
`v3.9.0` release in
[`Harness CI` run 25131209377](https://github.com/Rul1an/Assay-Harness/actions/runs/25131209377)
before the `v0.3.2` tag. The recipes were re-verified against Assay
`v3.12.0` in
[`Harness CI` run 26543125840](https://github.com/Rul1an/Assay-Harness/actions/runs/26543125840)
on 2026-05-27, three minor versions after the previous proof, and against
Assay `v3.13.0` in
[`Harness CI` run 26756652781](https://github.com/Rul1an/Assay-Harness/actions/runs/26756652781)
on 2026-06-01. The recipes were re-verified against Assay `v3.14.0` in
[`Harness CI` run 26774284155](https://github.com/Rul1an/Assay-Harness/actions/runs/26774284155)
on 2026-06-01, and against Assay `v3.19.1` in
[`Harness CI` run 27091183205](https://github.com/Rul1an/Assay-Harness/actions/runs/27091183205)
on 2026-06-07. The latest re-verification passed against Assay `v3.27.0` in
[`Harness CI` run 27651437917](https://github.com/Rul1an/Assay-Harness/actions/runs/27651437917)
on 2026-06-17, the first recorded proof since `v3.19.1`; the workflow
`assay_version` default (previously `v3.26.0` from #115, without a recorded
proof) is aligned to the proved `v3.27.0` binary in the same change.

## Harness Boundary

Harness gate/report behavior is claim-family agnostic. Promptfoo, OpenFeature,
and CycloneDX recipes differ only by their input fixtures and Assay importer
commands.

Harness must not parse Promptfoo JSONL, OpenFeature JSONL, CycloneDX BOMs, or
Assay receipt payloads. It must not compare model versions, flag decisions,
dataset refs, assertion values, or domain-specific metadata. It only preserves,
gates, and projects the raw Assay Trust Basis diff contract.

## Distribution Boundary

For this line, Assay Harness is a GitHub release and repository CLI. The npm
package metadata is used for local Node tooling and release bookkeeping; it is
not a claim that the Harness CLI is published to npm. `exports`/`files` now
advertise only the CLI entry (`dist/cli.js`) and omit
`scripts/probe-v54-enforcement-health.mjs` from the packed surface. That is
formally deep-import-breaking; there are zero known consumers and the package
is not on the public registry on this line. Tests and the workflow still run
the script via repository checkout. This is not a claim that `dist/` already
ships in today's pack — only that the CLI remains installable once built.
