#!/usr/bin/env bash
# Demo: the conformance carrier gate over real supply-chain conformance carriers.
#
# The Harness consumes an `assay.supply_chain_conformance.v0` carrier (produced by
# Rul1an/assay, crates/assay-registry), validates its frozen shape, gates CI on the
# producer-owned `policy_result`, and projects Markdown / JUnit / SARIF. This demo
# runs the gate over the vendored fixtures and asserts the exit-code contract.
#
# NOTE: assay does not yet expose a CLI that emits this carrier (it is produced by
# the assay-registry library and the MCP04 witness). When a released-binary emitter
# lands, this demo can be promoted into the `Harness CI` release-binary compat job
# the same way the Promptfoo / OpenFeature / CycloneDX recipes are. Until then it
# runs against vendored real carrier bytes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="$here/harness/dist/cli.js"
fixtures="$here/harness/fixtures/supply-chain-conformance"
out="${1:-$here/results/supply-chain-conformance}"

if [ ! -f "$cli" ]; then
  echo "harness CLI not built; run: npm --prefix harness run build" >&2
  exit 2
fi
mkdir -p "$out"

expect() {
  local fixture="$1" want="$2"
  set +e
  node "$cli" carrier supply-chain --carrier "$fixtures/$fixture" --out-dir "$out/${fixture%.json}" >/dev/null 2>&1
  local got=$?
  set -e
  if [ "$got" -ne "$want" ]; then
    echo "FAIL: $fixture expected exit $want, got $got" >&2
    exit 1
  fi
  echo "ok: $fixture -> exit $got"
}

# pass / keyless are clean; fail / incomplete / unsupported are not clean (incomplete
# is never clean); unknown-status / wrong-schema are contract errors.
expect pass.conformance.json 0
expect keyless.conformance.json 0
expect fail.conformance.json 6
expect incomplete.conformance.json 6
expect unsupported.conformance.json 6
expect unknown-status.conformance.json 3
expect wrong-schema.conformance.json 3

echo "supply-chain conformance carrier gate demo: all cases matched the exit-code contract"
