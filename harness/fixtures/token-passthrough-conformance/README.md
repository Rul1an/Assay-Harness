# Token-passthrough conformance carrier fixtures

Test fixtures for the `carrier token-passthrough` gate. Each is an
`assay.token_passthrough_conformance.v0` carrier (producer: `Rul1an/assay`,
`crates/assay-mcp-server/src/token_passthrough.rs`). The Harness validates the
frozen shape, gates on the producer-reported per-channel facts (a consumed inbound
auth value not re-emitted on a checked outbound channel), and projects Markdown /
JUnit / SARIF.

| Fixture | Source | Harness gate |
|---|---|---|
| `clean.conformance.json` | the producer's deterministic consuming-path report (transport_header + json_body checked-clean, environment not_applicable) | clean (exit 0) |
| `leak.conformance.json` | synthetic, `transport_header` with `leak_count=1` and `pass=false` | not clean (exit 6) |
| `wrong-schema.conformance.json` | synthetic, `schema` is a future id with no adapter | invalid (exit 3) |

A carrier is clean iff every checked outbound channel reports `leak_count == 0` and
is not `pass == false`. Channels marked `not_applicable` are out of scope and
skipped; the transparent relay is recorded but out of scope.
