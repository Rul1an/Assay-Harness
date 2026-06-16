# Render-safety conformance carrier fixtures

Test fixtures for the `carrier render-safety` gate. Each is an
`assay.render_safety_conformance.v0` carrier (producer:
`Rul1an/assay`, `crates/assay-core/src/render_safety`). The Harness validates the
frozen shape, gates on the producer-reported per-sink facts (raw secret / PII /
terminal-control leak counts, redaction-before-truncation, benign-preserved), and
projects Markdown / JUnit / SARIF.

| Fixture | Source | Harness gate |
|---|---|---|
| `clean.conformance.json` | the real producer golden (`render_safety_conformance.v0.golden.json`), all six sinks clean | clean (exit 0) |
| `leak.conformance.json` | synthetic, one sink with `raw_secret_leak_count=1` | not clean (exit 6) |
| `truncation-order.conformance.json` | synthetic, one sink with `redaction_before_truncation=false` | not clean (exit 6) |
| `wrong-schema.conformance.json` | synthetic, `schema` is a future id with no adapter | invalid (exit 3) |

A sink is clean iff all three leak counts are 0 and `redaction_before_truncation`
and `benign_preserved` are true; the report is clean iff every sink is clean. This
mirrors the producer's own `is_clean`.
