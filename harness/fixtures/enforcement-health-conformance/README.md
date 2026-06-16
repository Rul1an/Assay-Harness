# Enforcement-health conformance carrier fixtures

Test fixtures for the `carrier enforcement-health` gate. Each is an
`assay.enforcement_health.v1` carrier (producer: `Rul1an/assay`,
`crates/assay-cli/src/enforcement_health_v1.rs` — the Landlock TCP-connect
port-allowlist domain). The Harness validates the frozen shape, gates CI on the
producer-reported status, and projects Markdown / JUnit / SARIF.

`active-with-probe`, `active-no-probe`, and `failed` are the real producer test
fixtures, vendored verbatim.

| Fixture | `status` | Harness gate | Notes |
|---|---|---|---|
| `active-with-probe.conformance.json` | `active` | clean (exit 0) | a real-block probe confirmed a denied connect (EACCES, listener not reached) |
| `active-no-probe.conformance.json` | `active` | clean (exit 0) | ruleset applied (`no_new_privs` + `restrict_self`), no real-block claim |
| `failed.conformance.json` | `failed` | not clean (exit 6) | enforcement requested but not installed (`landlock_abi_too_old`) |
| `wrong-schema.conformance.json` | n/a | invalid (exit 3) | a future `v2` schema id with no adapter |

Gate: `status=active` is clean (the ruleset was applied); `status=failed` is not
clean (enforcement requested but not installed). A real-block probe upgrades the
evidence to "a denied connect was really blocked" and is surfaced, but is not
required for a clean gate.

Boundary: this is the carrier-local honest-state gate (was enforcement requested,
and did the ruleset apply or fail), distinct from the enforcement-truth review
(policy-aware approval over the enforcement outcome), which is a separate step. The
connect4/eBPF `assay.enforcement_health.v0` carrier is a different shape and is not
consumed by this adapter.
