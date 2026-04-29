# P46 — Three-Family Trust Basis Compatibility Refresh

> **Status:** implemented on main
> **Target repo:** `Rul1an/Assay-Harness`
> **Depends on:** Assay P45b, Assay Harness P38/P42/P44

---

## One-Line Goal

Refresh Harness docs, fixtures, and recipe tests so the existing generic
Trust Basis gate/report layer carries the released Assay v3.8.0 claim surface across
eval, decision, and inventory receipt families.

## Scope

P46 is a compatibility refresh, not a feature slice.

It aligns Harness with the released Assay v3.8.0 Trust Basis surface:

- `assay.trust-basis.diff.v1`
- Trust Card schema v5
- 10 frozen Trust Basis claims
- eval, decision, and inventory receipt boundary claims

## Boundary

P46 introduces no new claim semantics, no new report semantics, and no
family-specific gate logic.

Harness still does not parse Promptfoo JSONL, OpenFeature JSONL, CycloneDX
BOMs, or Assay receipt payloads. It does not compare assertion values, flag
decisions, model versions, dataset refs, or family-specific metadata.

Promptfoo, OpenFeature, and CycloneDX differ only by recipe input fixtures and
the Assay importer command used by the recipe.

## Acceptance

- Trust Basis contract fixtures use the released Assay v3.8.0 10-claim surface.
- Promptfoo regression fixtures regress `external_eval_receipt_boundary_visible`.
- OpenFeature regression fixtures regress `external_decision_receipt_boundary_visible`.
- CycloneDX regression fixtures regress `external_inventory_receipt_boundary_visible`.
- The same Harness gate/report behavior handles all three families.
- Compatibility docs identify Assay v3.8.0 as the exact compatibility target.

## Release Note

This branch targets the released Assay `v3.8.0` release line.
