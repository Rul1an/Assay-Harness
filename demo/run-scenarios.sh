#!/usr/bin/env bash
#
# Demo runner: maps all scenario fixtures and compares each against the
# clean-baseline to show regression detection in action.
#
# Usage:
#   ./demo/run-scenarios.sh
#
# Requirements:
#   - Python 3 (for the mapper)
#   - Node.js + npm (for the harness compare command)
#   - Run `npm install` in harness/ first
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCENARIOS="$ROOT/fixtures/scenarios"
MAPPER="$ROOT/mapper/map_to_assay.py"
IMPORT_TIME="2026-04-16T12:00:00Z"

# Track results
PASS=0
FAIL=0
TOTAL=0

divider() {
  printf '\n%s\n' "$(printf '=%.0s' {1..70})"
}

section() {
  divider
  printf '  %s\n' "$1"
  printf '%s\n\n' "$(printf '=%.0s' {1..70})"
}

# ---------------------------------------------------------------
# Step 1: Map all scenarios to NDJSON
# ---------------------------------------------------------------

section "Step 1: Mapping scenario fixtures to Assay NDJSON"

SCENARIOS_LIST=(
  "clean-baseline"
  "new-approval"
  "deny-regression"
  "policy-drift-resume"
)

for name in "${SCENARIOS_LIST[@]}"; do
  printf '  Mapping %-30s ... ' "$name"
  if python3 "$MAPPER" \
    "$SCENARIOS/$name.harness.json" \
    --output "$SCENARIOS/$name.assay.ndjson" \
    --import-time "$IMPORT_TIME" \
    --overwrite \
    > /dev/null 2>&1; then
    printf 'OK\n'
  else
    printf 'FAILED\n'
  fi
done

# ---------------------------------------------------------------
# Step 2: Compare each scenario against clean-baseline
# ---------------------------------------------------------------

BASELINE="$SCENARIOS/clean-baseline.assay.ndjson"

compare_scenario() {
  local name="$1"
  local label="$2"
  local expect_regression="$3"
  local candidate="$SCENARIOS/$name.assay.ndjson"

  TOTAL=$((TOTAL + 1))

  section "Scenario: $label"

  printf '  Baseline:   %s\n' "clean-baseline.assay.ndjson"
  printf '  Candidate:  %s\n\n' "$name.assay.ndjson"

  local output
  local exit_code=0
  output=$(npx --prefix "$ROOT/harness" tsx "$ROOT/harness/src/cli.ts" compare \
    --baseline "$BASELINE" \
    --candidate "$candidate" 2>&1) || exit_code=$?

  echo "$output"

  if [ "$expect_regression" = "yes" ] && [ "$exit_code" -eq 6 ]; then
    printf '\n  Result: REGRESSION detected (exit code 6) -- expected\n'
    PASS=$((PASS + 1))
  elif [ "$expect_regression" = "no" ] && [ "$exit_code" -eq 0 ]; then
    printf '\n  Result: No regressions (exit code 0) -- expected\n'
    PASS=$((PASS + 1))
  else
    printf '\n  Result: UNEXPECTED exit code %d (expected regression=%s)\n' "$exit_code" "$expect_regression"
    FAIL=$((FAIL + 1))
  fi
}

compare_scenario "clean-baseline" \
  "Clean baseline vs itself (no regressions)" \
  "no"

compare_scenario "new-approval" \
  "PR introduces new approval (deploy_to_staging)" \
  "yes"

compare_scenario "deny-regression" \
  "Policy change causes deny regression (write_file)" \
  "yes"

compare_scenario "policy-drift-resume" \
  "Resume with policy snapshot mismatch" \
  "yes"

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------

section "Demo Summary"

printf '  Scenarios run:    %d\n' "$TOTAL"
printf '  Expected result:  %d\n' "$PASS"
printf '  Unexpected:       %d\n' "$FAIL"
echo ""

if [ "$FAIL" -eq 0 ]; then
  printf '  All scenarios produced expected results.\n'
else
  printf '  WARNING: %d scenario(s) did not produce expected results.\n' "$FAIL"
fi

divider
echo ""
