# Supply-Chain Conformance Carrier Gate

**Status:** OK
**Schema:** `assay.supply_chain_conformance.v0`
**Carrier:** `/tmp/a5a3dl/supply-chain-conformance.dsse.json`

> This gate surfaces the producer-computed `policy_result` from the carrier and
> the per-dimension statuses it reports. It does not approve, certify, judge
> compliance, or assert provider trust, runtime truth, or supply-chain safety;
> policy-aware review is a separate step.

- Subject: `example-artifact` @ `1.0.0` (`sha256:1111111111111111111111111111111111111111111111111111111111111111`)
- Producer policy_result: `pass`
- SLSA build level: declared `L1`, verified `L2`

| Group | Dimension | Status | Class |
| --- | --- | --- | --- |
| integrity | artifact_digest | `verified` | verified |
| integrity | subject_digest_binding | `verified` | verified |
| pinning | digest_pinned | `verified` | verified |
| pinning | lockfile_subject_matches_artifact | `verified` | verified |
| pinning | no_floating_source_ref | `verified` | verified |
| pinning | no_tag_only_container_ref | `not_applicable` | not_applicable |
| pinning | version_pinned | `verified` | verified |
| provenance | builder_identity | `verified` | verified |
| provenance | cert_chain | `not_applicable` | not_applicable |
| provenance | consistency | `not_applicable` | not_applicable |
| provenance | dsse_pae | `not_applicable` | not_applicable |
| provenance | dsse_signature | `verified` | verified |
| provenance | identity | `not_applicable` | not_applicable |
| provenance | rekor_inclusion | `not_applicable` | not_applicable |
| provenance | sigstore_bundle | `not_applicable` | not_applicable |
| provenance | slsa_provenance | `verified` | verified |
| provenance | timestamp_freshness | `not_applicable` | not_applicable |
| provenance | witnessing | `not_applicable` | not_applicable |

## Coverage limits (carried from the carrier)

- transitive dependencies not re-fetched
- PEP 740 / npm provenance adapters not verified in this slice
- live transparency-log lookup not performed offline

## Non-claims (carried from the carrier)

- provenance verification does not prove code safety
- verified provenance does not prove absence of malicious behaviour
- verified signer identity is not a judgement that the provider is trustworthy
- not_present is not a silent pass when policy requires provenance

