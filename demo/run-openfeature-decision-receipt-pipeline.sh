#!/usr/bin/env bash
#
# P42 recipe: OpenFeature EvaluationDetails -> Assay receipts/bundles -> Trust Basis -> Harness gate/report.
#
# This is a recipe over existing contracts, not a new semantic layer. Assay owns
# OpenFeature parsing, receipt reduction, evidence bundles, Trust Basis
# generation, and diff semantics. Harness preserves and projects the resulting
# Assay diff.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$ROOT/harness"
FIXTURES="$HARNESS/fixtures/openfeature-decision-receipt-pipeline"
ASSAY_BIN="${ASSAY_BIN:-assay}"
OUT_DIR=""
CASE="nonregression"
OVERWRITE=0
IMPORT_TIME_BASELINE="2026-04-28T09:00:00Z"
IMPORT_TIME_CANDIDATE="2026-04-28T09:01:00Z"

usage() {
  cat <<'EOF'
Usage:
  demo/run-openfeature-decision-receipt-pipeline.sh --out-dir <dir> [options]

Options:
  --case <name>       nonregression | trust-basis-regression-fixture
                      (default: nonregression)
  --assay-bin <path>  Assay CLI executable path or command name
                      (default: $ASSAY_BIN or assay; not a shell command string)
  --overwrite         Remove and recreate --out-dir if it already has files
  -h, --help          Show this help

Exit codes:
  0  no Trust Basis regressions
  1  Trust Basis regressions present
  2  recipe/config/tool/input/runtime error
EOF
}

die() {
  printf '[openfeature-decision-pipeline] ERROR: %s\n' "$*" >&2
  exit 2
}

canonical_out_dir() {
  local parent
  local base
  if [ -d "$OUT_DIR" ]; then
    (cd "$OUT_DIR" && pwd -P)
    return
  fi

  parent="$(dirname "$OUT_DIR")"
  base="$(basename "$OUT_DIR")"
  [ -d "$parent" ] || return 1
  printf '%s/%s\n' "$(cd "$parent" && pwd -P)" "$base"
}

guard_safe_out_dir() {
  local canonical
  local root_real
  local harness_real
  local home_real=""
  canonical="$(canonical_out_dir)" || die "--out-dir parent does not exist: $OUT_DIR"
  root_real="$(cd "$ROOT" && pwd -P)"
  harness_real="$(cd "$HARNESS" && pwd -P)"
  if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
    home_real="$(cd "$HOME" && pwd -P)"
  fi

  if [ "$canonical" = "/" ] \
    || [ "$canonical" = "$root_real" ] \
    || [ "$canonical" = "$harness_real" ] \
    || { [ -n "$home_real" ] && [ "$canonical" = "$home_real" ]; }; then
    die "refusing dangerous --out-dir: $OUT_DIR"
  fi
}

out_dir_has_entries() {
  [ -n "$(find "$OUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]
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
  nonregression|trust-basis-regression-fixture) ;;
  *) die "--case must be nonregression or trust-basis-regression-fixture" ;;
esac

if [ -e "$OUT_DIR" ] && [ ! -d "$OUT_DIR" ]; then
  die "--out-dir exists and is not a directory: $OUT_DIR"
fi

guard_safe_out_dir

if [ -e "$OUT_DIR" ] && out_dir_has_entries; then
  if [ "$OVERWRITE" -ne 1 ]; then
    die "--out-dir already contains files; pass --overwrite to recreate it"
  fi
  rm -rf "$OUT_DIR"
fi

mkdir -p "$OUT_DIR/baseline" "$OUT_DIR/candidate" "$OUT_DIR/reports"

command -v node >/dev/null 2>&1 || die "node is required to inspect Trust Basis diff JSON"
command -v npx >/dev/null 2>&1 || die "npx is required to run Assay Harness"
"$ASSAY_BIN" evidence import openfeature-details --help >/dev/null 2>&1 \
  || die "ASSAY_BIN cannot run evidence import openfeature-details: $ASSAY_BIN"
"$ASSAY_BIN" evidence verify --help >/dev/null 2>&1 \
  || die "ASSAY_BIN cannot run evidence verify: $ASSAY_BIN"
"$ASSAY_BIN" trust-basis generate --help >/dev/null 2>&1 \
  || die "ASSAY_BIN cannot run trust-basis generate: $ASSAY_BIN"
"$ASSAY_BIN" trust-basis diff --help >/dev/null 2>&1 \
  || die "ASSAY_BIN cannot run trust-basis diff: $ASSAY_BIN"

HARNESS_CLI=(npx --prefix "$HARNESS" tsx "$HARNESS/src/cli.ts")
"${HARNESS_CLI[@]}" trust-basis report \
  --diff "$HARNESS/fixtures/trust-basis/nonregression.trust-basis.diff.json" \
  >/dev/null 2>&1 \
  || die "assay-harness trust-basis report is not runnable through npx"

require_file() {
  local path="$1"
  local label="$2"
  [ -f "$path" ] || die "expected $label missing: $path"
}

copy_input() {
  local src="$1"
  local dst="$2"
  cp "$src" "$dst"
}

import_openfeature_side() {
  local side="$1"
  local input="$2"
  local import_time="$3"
  local run_id="openfeature_${side}"
  local side_dir="$OUT_DIR/$side"
  local jsonl="$side_dir/$side.openfeature-details.jsonl"
  local bundle="$side_dir/$side.evidence.tar.gz"
  local verify_log="$side_dir/$side.verify.txt"
  local trust_basis="$side_dir/$side.trust-basis.json"

  copy_input "$input" "$jsonl"
  "$ASSAY_BIN" evidence import openfeature-details \
    --input "$jsonl" \
    --bundle-out "$bundle" \
    --source-artifact-ref "$side.openfeature-details.jsonl" \
    --run-id "$run_id" \
    --import-time "$import_time" \
    >"$side_dir/$side.import.stdout.txt" \
    2>"$side_dir/$side.import.stderr.txt"
  require_file "$bundle" "$side evidence bundle"
  "$ASSAY_BIN" evidence verify "$bundle" \
    >"$verify_log" \
    2>"$side_dir/$side.verify.stderr.txt"
  require_file "$verify_log" "$side verification log"
  "$ASSAY_BIN" trust-basis generate "$bundle" --out "$trust_basis" \
    >"$side_dir/$side.trust-basis.stdout.txt" \
    2>"$side_dir/$side.trust-basis.stderr.txt"
  require_file "$trust_basis" "$side Trust Basis artifact"
}

import_openfeature_side "baseline" \
  "$FIXTURES/baseline.openfeature-details.jsonl" \
  "$IMPORT_TIME_BASELINE"

if [ "$CASE" = "nonregression" ]; then
  import_openfeature_side "candidate" \
    "$FIXTURES/candidate-nonregression.openfeature-details.jsonl" \
    "$IMPORT_TIME_CANDIDATE"
else
  copy_input \
    "$FIXTURES/candidate-trust-basis-regression-fixture.trust-basis.json" \
    "$OUT_DIR/candidate/candidate.trust-basis.json"
  require_file "$OUT_DIR/candidate/candidate.trust-basis.json" "candidate Trust Basis regression fixture"
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

require_file "$OUT_DIR/trust-basis.diff.json" "Trust Basis diff artifact"

DIFF_HAS_REGRESSIONS="$(node -e '
const fs = require("node:fs");
try {
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (report.schema !== "assay.trust-basis.diff.v1" || typeof report.summary?.has_regressions !== "boolean") {
    process.exit(2);
  }
  process.stdout.write(report.summary.has_regressions ? "yes" : "no");
} catch {
  process.exit(2);
}
' "$OUT_DIR/trust-basis.diff.json")" \
  || die "Trust Basis diff did not match assay.trust-basis.diff.v1"

if [ "$GATE_STATUS" -ne 0 ] && [ "$DIFF_HAS_REGRESSIONS" != "yes" ]; then
  cat "$OUT_DIR/reports/trust-basis-gate.stderr.txt" >&2
  die "assay-harness trust-basis gate failed with exit code $GATE_STATUS"
fi

"${HARNESS_CLI[@]}" trust-basis report \
  --diff "$OUT_DIR/trust-basis.diff.json" \
  --summary-out "$OUT_DIR/trust-basis-summary.md" \
  --junit-out "$OUT_DIR/junit-trust-basis.xml" \
  >"$OUT_DIR/reports/trust-basis-report.stdout.txt" \
  2>"$OUT_DIR/reports/trust-basis-report.stderr.txt"
require_file "$OUT_DIR/trust-basis-summary.md" "Trust Basis Markdown summary"
require_file "$OUT_DIR/junit-trust-basis.xml" "Trust Basis JUnit projection"

printf '[openfeature-decision-pipeline] case: %s\n' "$CASE"
printf '[openfeature-decision-pipeline] output: %s\n' "$OUT_DIR"
printf '[openfeature-decision-pipeline] baseline bundle: %s\n' "$OUT_DIR/baseline/baseline.evidence.tar.gz"
printf '[openfeature-decision-pipeline] baseline trust basis: %s\n' "$OUT_DIR/baseline/baseline.trust-basis.json"
if [ "$CASE" = "nonregression" ]; then
  printf '[openfeature-decision-pipeline] candidate bundle: %s\n' "$OUT_DIR/candidate/candidate.evidence.tar.gz"
else
  printf '[openfeature-decision-pipeline] candidate bundle: n/a (Trust Basis fixture case)\n'
fi
printf '[openfeature-decision-pipeline] candidate trust basis: %s\n' "$OUT_DIR/candidate/candidate.trust-basis.json"
printf '[openfeature-decision-pipeline] diff: %s\n' "$OUT_DIR/trust-basis.diff.json"
printf '[openfeature-decision-pipeline] summary: %s\n' "$OUT_DIR/trust-basis-summary.md"
printf '[openfeature-decision-pipeline] junit: %s\n' "$OUT_DIR/junit-trust-basis.xml"

if [ "$DIFF_HAS_REGRESSIONS" = "yes" ]; then
  printf '[openfeature-decision-pipeline] result: Trust Basis regression\n'
  exit 1
fi

printf '[openfeature-decision-pipeline] result: no Trust Basis regressions\n'
exit 0
