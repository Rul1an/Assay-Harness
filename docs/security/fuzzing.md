# Fuzzing posture

The harness ingests untrusted artifacts — Assay carriers, suite-compatibility matrices,
recipe provenance, and Evidence Packs. The highest-value hostile-input surface is the
Evidence Pack verifier (`verifyEvidencePack`), which parses an attacker-controllable
`manifest.json` and walks the files it lists. It is written to fail closed: any malformed,
inconsistent, or unsafe pack must return a structured error, never throw, and never report
`valid` unless every invariant holds.

`harness/test/suite_evidence_pack_fuzz.test.mjs` exercises that property with randomized
input. Starting from the committed valid pack it applies seeded random mutations — path
traversal, duplicate paths, unknown roles, digest mismatches, type confusion, missing
fields, and outright garbage manifests — and asserts that the verifier:

- never throws;
- always returns `{ valid: boolean, errors: [...] }` with string error codes;
- reports `valid` if and only if there are no errors;
- never reports a garbage manifest as valid.

## Running

The fuzz test runs as part of `npm test` (it matches `test/*.mjs`), so it is exercised on
every pull request. To run it on its own, or harder:

```bash
npm run test:fuzz
ASSAY_FUZZ_ROUNDS=5000 npm run test:fuzz     # more rounds
ASSAY_FUZZ_SEED=0xc0ffee npm run test:fuzz   # a specific seed
```

The PRNG is seeded and the seed is printed in the test name, so any failure reproduces
deterministically.

## Scope and what's next

This is property/randomized testing against the existing verifier — not OSS-Fuzz or a
libFuzzer harness — so the OpenSSF Scorecard Fuzzing check may not register it. That
trade-off is deliberate: the aim is real coverage of the untrusted-input path rather than
a score change. Planned next targets, in priority order: the suite-compatibility matrix
validator and the carrier supply-chain status validator.
