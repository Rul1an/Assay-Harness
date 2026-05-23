# `examples/runner/` — demo fixtures

Synthetic fixtures for [`docs/DEMO_RUNNER.md`](../../docs/DEMO_RUNNER.md).

## Files

| File | Tracked? | Produced by |
|---|---|---|
| `build-fixtures.mjs` | ✅ tracked | hand-written generator |
| `clean.tar.gz` | ⛔ git-ignored | `build-fixtures.mjs` |
| `regression.tar.gz` | ⛔ git-ignored | `build-fixtures.mjs` |
| `cross-runtime-diff-clean.json` | ⛔ git-ignored | `build-fixtures.mjs` |
| `cross-runtime-diff-regression.json` | ⛔ git-ignored | `build-fixtures.mjs` |

`build-fixtures.mjs` is the canonical source. The `.tar.gz` archives and the cross-runtime diff JSONs are regenerated locally on demand so the tree stays text-only.

## Regenerate

From the repo root:

```bash
node examples/runner/build-fixtures.mjs
```

That writes the four artefacts into this directory. See `docs/DEMO_RUNNER.md` for the full walkthrough.

## What these fixtures are

- **Tier-1-clean Runner archives** with the v0 manifest shape and the
  `sha256:<hex>` digest format the Runner core writes.
- **Strict v0 clean cross-runtime diff JSONs** that pass Harness's
  full clean-schema validator (status, runtime enum, distinct
  runtimes, preconditions, scope, A1+B3+C1 canonicalisation, unbound
  empty, ambiguities empty, fixed `non_claims` and `notes`, surface
  `uniqueItems`).

## What these fixtures are not

- **Not real measured runs.** No eBPF, no real kernel/policy/SDK events.
  The `events.ndjson` and `layers/*.ndjson` streams in the archives
  are empty.
- **Not a stable contract.** Treat the values as illustrative; only the
  schema strings and v0 invariants are stable, and those are owned
  Runner-side.
- **Not test fixtures.** The harness test suite has its own in-test
  fixture builder in `harness/test/runner_*.test.mjs`. The demo
  generator is separate so each can evolve without coupling.
