# Supply-chain conformance carrier fixtures

Test fixtures for the `carrier supply-chain` gate. Each is an
`assay.supply_chain_conformance.v0` carrier (the producer contract lives in
`Rul1an/assay`, `crates/assay-registry/src/supply_chain.rs`). The Harness is a
consumer: it validates the frozen shape, gates on the producer-owned
`policy_result`, and projects to Markdown / JUnit / SARIF. It does not compute
the carrier.

## Gate-case fixtures (real producer output)

`pass`, `fail`, `incomplete`, and `unsupported` are real carrier bytes emitted by
the assay supply-chain verifier (pinned-key path; placeholder subject digest
`sha256:1111...`). They exercise the producer-owned gate:

| Fixture | `policy_result` | Harness gate | Notes |
|---|---|---|---|
| `pass.conformance.json` | `pass` | clean (exit 0) | all dimensions verified |
| `fail.conformance.json` | `fail` | not clean (exit 6) | `subject_digest_binding=subject_digest_mismatch`, `slsa_provenance=failed` |
| `incomplete.conformance.json` | `incomplete` | not clean (exit 6) | provenance dimensions `not_present` |
| `unsupported.conformance.json` | `incomplete` | not clean (exit 6) | provenance dimensions `unsupported_format` |

## Shape fixture (current keyless dimensions)

`keyless.conformance.json` is a shape-accurate v3.27.0 carrier carrying the
MCP04a-3.4 Sigstore-keyless dimensions (`cert_chain`, `identity`, `dsse_pae`,
`timestamp_freshness`, `consistency`, `witnessing`). It proves the adapter parses
the full current provenance key set, including `not_checked` for the
offline-not-computed dimensions. Synthetic (hand-built to the producer struct),
`policy_result=pass`.

## Negative fixtures (contract guards)

| Fixture | Expected | Guard |
|---|---|---|
| `unknown-status.conformance.json` | invalid (exit 3) | a dimension carries a status outside the frozen `CheckStatus` set; an uninterpretable status is never read as clean |
| `wrong-schema.conformance.json` | invalid (exit 3) | `schema` is a future/unknown id with no registered adapter |

The frozen status set and `policy_result` set are append-only on the producer.
An unknown status or unknown `policy_result` is rejected as a contract error
(`artifact_contract`, exit 3) rather than silently passing.
