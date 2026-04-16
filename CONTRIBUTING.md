# Contributing to Assay-Harness

## Prerequisites

- Node.js 20+
- Python 3.12+
- npm

## Setup

```bash
cd harness && npm install
```

## Testing

```bash
# Type-check the harness
npx tsc --noEmit

# Run Python tests
python3 -m pytest tests/ -v

# Run the mapper against a fixture
python3 mapper/map_to_assay.py fixtures/valid.harness.json \
  --output /tmp/test.ndjson \
  --import-time 2026-04-16T12:00:00Z \
  --overwrite
```

## Branch strategy

- All changes go through pull requests against `main`.
- Use squash merge.

## Commit conventions

- Use imperative mood in commit messages.
- Prefix with the affected component:
  - `harness:` -- runtime changes
  - `mapper:` -- mapper script changes
  - `ci:` -- CI/workflow changes
  - `policy:` -- policy engine changes
  - `contracts:` -- evidence or artifact contract changes

Examples:

```
harness: add timeout to approval gate
mapper: fix NDJSON line ordering for resume records
contracts: update exit-code enum in evidence schema
```

## Contract changes

Any change to the evidence schema, policy schema, exit codes, or NDJSON format **must** include updates to the corresponding golden contract tests. PRs that modify contracts without updating golden tests will not be merged.

## Evidence boundaries

Evidence compiled by the harness must never contain:

- **Transcript truth** -- raw LLM conversation transcripts
- **Session truth** -- internal session state or debug data
- **Raw state** -- unprocessed harness runtime state

All evidence must go through the evidence compiler and conform to the artifact contract.
