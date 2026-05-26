# Runner Archive Fixture Provenance

> Closes [`Rul1an/Assay-Harness#65`](https://github.com/Rul1an/Assay-Harness/issues/65).
> Adds a real Assay-Runner archive to the test suite so contract drift
> between `Rul1an/assay` Runner-side emission and Harness-side parsing
> surfaces as a Harness test failure, instead of hiding behind the
> internally-consistent synthetic fixtures.

## File

| Path | Source archive | Source commit | Live workflow run |
|---|---|---|---|
| [`slice3-arm-c-kernel-event-v0.tar.gz`](slice3-arm-c-kernel-event-v0.tar.gz) | `Rul1an/assay` `docs/experiments/runner-vs-otel-2026-05/runs/slice3-arm-c-kernel-event-v0/run_arm_c_20260526T090509Z_1/archive-contents/` | [`ee343650`](https://github.com/Rul1an/assay/commit/ee343650) (PR [#1377](https://github.com/Rul1an/assay/pull/1377)) | <https://github.com/Rul1an/assay/actions/runs/26442807783> |

## How it was produced upstream

The archive is the first iteration of the Slice 3 Arm C rerun in
`Rul1an/assay`. It was captured on the delegated `assay-bpf-runner`
self-hosted runner under Linux/eBPF + cgroup-v2, with `tampering_mode=true`
to exercise the reported-intent vs measured-effect mismatch path. Each
iteration in that rerun passes the workflow health gate
(`ringbuf_drops == 0`, `kernel_layer == "complete"`,
`cgroup_correlation == "clean"`) and the workload contract-checker
before its artifacts are uploaded.

The committed evidence in `Rul1an/assay` keeps the `.tar.gz`
**unpacked** under `archive-contents/`; the raw `.tar.gz` is not
tracked there. This fixture is a repack of those committed files,
produced once at vendor time. The repack:

- preserves every file's exact bytes (manifest `sha256:<hex>` digests
  still match the contents);
- uses `tar --format=ustar -czf` so the layout is the same plain
  ustar subset that `harness/test/runner_archive.test.mjs` already
  exercises against synthetic archives;
- regenerates tar timestamps and uid/gid metadata; these are not part
  of the archive contract.

The Tier-1 validator (`validateRunnerArchive`) only checks file
**contents** against the manifest, so the repack is contract-equivalent
to the original `.tar.gz` artifact.

## Refresh policy

Refresh the fixture only when:

1. `Rul1an/assay` lands an archive-schema change in
   `crates/assay-runner-schema/` that Harness needs to follow; OR
2. a new optional payload field appears under `archive-contents/` that
   Harness wants to start consuming.

Routine cosmetic changes in the experiment evidence do not require
refresh. When refreshing, pin the new source commit + workflow URL in
the table above.

## What this fixture proves

Catches the failure mode that synthetic-only coverage cannot:

- Runner-side bumps an `assay.runner.*.v0` schema or relaxes its shape;
- Runner-side renames a manifest field;
- Runner-side changes the manifest digest prefix (this is exactly the
  `sha256:<hex>` bug surfaced in PR `#59` review);
- Runner-side changes a top-level file that Harness pins by schema
  string or parses for Tier-1 honest-health
  (`manifest.json`, `observation-health.json`, `correlation-report.json`,
  `capability-surface.json`). Tier-1 does not enforce an archive-wide
  file allowlist, so a Runner archive that adds an unrelated new file
  alongside the existing manifest entries will still pass; only changes
  to the parsed/gated files surface here.

Anything that breaks Harness's strict shape guard against a live
upstream emission surfaces as a CI failure on this single smoke test.

## What this fixture does NOT prove

- No Linux/eBPF acceptance signal here. The kernel capture happened
  upstream; the fixture is a static byte snapshot.
- No live measurement claims. This is a parser-contract smoke, not an
  overhead or behaviour test.
- No Tier-2 diff or Tier-3 cross-runtime claims. Those tests live
  alongside this one in `harness/test/` and consume different
  fixtures.
