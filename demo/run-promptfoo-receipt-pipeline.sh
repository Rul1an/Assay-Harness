#!/usr/bin/env bash
#
# P38 recipe: Promptfoo JSONL -> Assay receipts/bundles -> Trust Basis -> Harness gate/report.
#
# This is a recipe over existing contracts, not a new semantic layer. Assay owns
# Promptfoo parsing, receipt reduction, evidence bundles, Trust Basis generation,
# and diff semantics. Harness preserves and projects the resulting Assay diff.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$ROOT/harness"
FIXTURES="$HARNESS/fixtures/promptfoo-receipt-pipeline"
ASSAY_BIN="${ASSAY_BIN:-assay}"
OUT_DIR=""
CASE="nonregression"
OVERWRITE=0
IMPORT_TIME_BASELINE="2026-04-27T09:00:00Z"
IMPORT_TIME_CANDIDATE="2026-04-27T09:01:00Z"

usage() {
  cat <<'EOF'
Usage:
  demo/run-promptfoo-receipt-pipeline.sh --out-dir <dir> [options]

Options:
  --case <name>       nonregression | boundary-regression (default: nonregression)
  --assay-bin <path>  Assay CLI binary (default: $ASSAY_BIN or assay)
  --overwrite         Remove and recreate --out-dir if it already has files
  -h, --help          Show this help

Exit codes:
  0  no Trust Basis regressions
  1  Trust Basis regressions present
  2  recipe/config/tool/input/runtime error
EOF
}

die() {
  printf '[promptfoo-receipt-pipeline] ERROR: %s\n' "$*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ "$#" -ge 2 ] || die "--out-dir requires a value"
      OUT_DIR="$2"
      shift 2
      ;;
    --case)
      [ "$#" -ge 2 ] || die "--case requires a value"
      CASE="$2"
      shift 2
      ;;
    --assay-bin)
      [ "$#" -ge 2 ] || die "--assay-bin requires a value"
      ASSAY_BIN="$2"
      shift 2
      ;;
    --overwrite)
      OVERWRITE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$OUT_DIR" ] || die "--out-dir is required"
case "$CASE" in
  nonregression|boundary-regression) ;;
  *) die "--case must be nonregression or boundary-regression" ;;
esac

if [ -e "$OUT_DIR" ] && [ ! -d "$OUT_DIR" ]; then
  die "--out-dir exists and is not a directory: $OUT_DIR"
fi

if [ -e "$OUT_DIR" ] && [ "$(find "$OUT_DIR" -mindepth 1 -maxdepth 1 | head -n 1)" ]; then
  if [ "$OVERWRITE" -ne 1 ]; then
    die "--out-dir already contains files; pass --overwrite to recreate it"
  fi
  rm -rf "$OUT_DIR"
fi

mkdir -p "$OUT_DIR/baseline" "$OUT_DIR/candidate" "$OUT_DIR/reports"

"$ASSAY_BIN" evidence import promptfoo-jsonl --help >/dev/null 2>&1 \
  || die "ASSAY_BIN cannot run evidence import promptfoo-jsonl: $ASSAY_BIN"
"$ASSAY_BIN" evidence verify --help >/dev/null 2>&1 \
  || die "ASSAY_BIN cannot run evidence verify: $ASSAY_BIN"
"$ASSAY_BIN" trust-basis generate --help >/dev/null 2>&1 \
  || die "ASSAY_BIN cannot run trust-basis generate: $ASSAY_BIN"
"$ASSAY_BIN" trust-basis diff --help >/dev/null 2>&1 \
  || die "ASSAY_BIN cannot run trust-basis diff: $ASSAY_BIN"

HARNESS_CLI=(npx --prefix "$HARNESS" tsx "$HARNESS/src/cli.ts")

copy_input() {
  local src="$1"
  local dst="$2"
  cp "$src" "$dst"
}

import_promptfoo_side() {
  local side="$1"
  local input="$2"
  local import_time="$3"
  local run_id="promptfoo_${side}"
  local side_dir="$OUT_DIR/$side"
  local jsonl="$side_dir/$side.results.jsonl"
  local bundle="$side_dir/$side.evidence.tar.gz"
  local verify_log="$side_dir/$side.verify.txt"
  local trust_basis="$side_dir/$side.trust-basis.json"

  copy_input "$input" "$jsonl"
  "$ASSAY_BIN" evidence import promptfoo-jsonl \
    --input "$jsonl" \
    --bundle-out "$bundle" \
    --source-artifact-ref "$side.results.jsonl" \
    --run-id "$run_id" \
    --import-time "$import_time" \
    >"$side_dir/$side.import.stdout.txt" \
    2>"$side_dir/$side.import.stderr.txt"
  "$ASSAY_BIN" evidence verify "$bundle" \
    >"$verify_log" \
    2>"$side_dir/$side.verify.stderr.txt"
  "$ASSAY_BIN" trust-basis generate "$bundle" --out "$trust_basis" \
    >"$side_dir/$side.trust-basis.stdout.txt" \
    2>"$side_dir/$side.trust-basis.stderr.txt"
}

import_promptfoo_side "baseline" \
  "$FIXTURES/baseline.results.jsonl" \
  "$IMPORT_TIME_BASELINE"

if [ "$CASE" = "nonregression" ]; then
  import_promptfoo_side "candidate" \
    "$FIXTURES/candidate-nonregression.results.jsonl" \
    "$IMPORT_TIME_CANDIDATE"
else
  copy_input \
    "$FIXTURES/candidate-boundary-regression.trust-basis.json" \
    "$OUT_DIR/candidate/candidate.trust-basis.json"
fi

set +e
"${HARNESS_CLI[@]}" trust-basis gate \
  --baseline "$OUT_DIR/baseline/baseline.trust-basis.json" \
  --candidate "$OUT_DIR/candidate/candidate.trust-basis.json" \
  --out "$OUT_DIR/trust-basis.diff.json" \
  --assay-bin "$ASSAY_BIN" \
  >"$OUT_DIR/reports/trust-basis-gate.stdout.txt" \
  2>"$OUT_DIR/reports/trust-basis-gate.stderr.txt"
GATE_STATUS=$?
set -e

if [ "$GATE_STATUS" -ne 0 ] && [ "$GATE_STATUS" -ne 6 ]; then
  cat "$OUT_DIR/reports/trust-basis-gate.stderr.txt" >&2
  die "assay-harness trust-basis gate failed with exit code $GATE_STATUS"
fi

"${HARNESS_CLI[@]}" trust-basis report \
  --diff "$OUT_DIR/trust-basis.diff.json" \
  --summary-out "$OUT_DIR/trust-basis-summary.md" \
  --junit-out "$OUT_DIR/junit-trust-basis.xml" \
  >"$OUT_DIR/reports/trust-basis-report.stdout.txt" \
  2>"$OUT_DIR/reports/trust-basis-report.stderr.txt"

printf '[promptfoo-receipt-pipeline] case: %s\n' "$CASE"
printf '[promptfoo-receipt-pipeline] output: %s\n' "$OUT_DIR"
printf '[promptfoo-receipt-pipeline] diff: %s\n' "$OUT_DIR/trust-basis.diff.json"

if [ "$GATE_STATUS" -eq 6 ]; then
  printf '[promptfoo-receipt-pipeline] result: Trust Basis regression\n'
  exit 1
fi

printf '[promptfoo-receipt-pipeline] result: no Trust Basis regressions\n'
exit 0
