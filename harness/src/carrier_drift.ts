/**
 * Carrier contract-drift detection.
 *
 * Given any conformance carrier, dispatch by its `schema` id to the registered
 * adapter and report whether the Harness recognizes the contract and the carrier
 * matches its frozen shape. A schema id with no registered adapter, or a
 * recognized schema whose shape does not validate, is contract drift: the Harness
 * is older than the carrier (or the producer changed the shape) and must not be
 * read as clean.
 *
 * This is the schema / shape dimension only. The per-carrier gate verdict
 * (pass/fail/clean) is the schema-specific verbs' job: a well-formed carrier that
 * reports a leak is contract-VALID here (exit 0) and fails its own gate verb
 * (exit 6) separately.
 */

import { existsSync, readFileSync } from "node:fs";
import { getCarrierAdapter, peekCarrierSchema, registeredCarrierSchemas } from "./carrier_registry.js";

export interface CarrierContractError {
  code: string;
  message: string;
  path?: string;
}

export interface CarrierContractResult {
  carrier_path: string;
  /** The carrier's declared schema id, or undefined when absent / non-string. */
  schema?: string;
  /** True when a registered adapter exists for the schema id. */
  recognized: boolean;
  /** True when recognized AND the carrier matches the adapter's frozen shape. */
  valid: boolean;
  errors: CarrierContractError[];
}

export function checkCarrierContract(carrierPath: string): CarrierContractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(carrierPath, "utf8"));
  } catch (err) {
    return {
      carrier_path: carrierPath,
      recognized: false,
      valid: false,
      errors: [
        {
          code: "CARRIER_NOT_JSON",
          message: `${carrierPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const schema = peekCarrierSchema(parsed);
  if (schema === undefined) {
    return {
      carrier_path: carrierPath,
      recognized: false,
      valid: false,
      errors: [{ code: "CARRIER_SCHEMA_MISSING", message: "carrier has no string `schema` field" }],
    };
  }

  const adapter = getCarrierAdapter(schema);
  if (!adapter) {
    return {
      carrier_path: carrierPath,
      schema,
      recognized: false,
      valid: false,
      errors: [
        {
          code: "CARRIER_SCHEMA_UNRECOGNIZED",
          message: `no registered adapter for schema ${JSON.stringify(schema)}; the Harness does not recognize this carrier contract (known: ${registeredCarrierSchemas().join(", ")})`,
        },
      ],
    };
  }

  const v = adapter.validate(parsed);
  return { carrier_path: carrierPath, schema, recognized: true, valid: v.valid, errors: v.errors };
}

export interface CarrierContractLoadResult {
  ok: boolean;
  not_found?: boolean;
  result?: CarrierContractResult;
}

export function loadCarrierContract(carrierPath: string): CarrierContractLoadResult {
  if (!carrierPath || !existsSync(carrierPath)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, result: checkCarrierContract(carrierPath) };
}

export function formatCarrierContractSummary(r: CarrierContractResult): string {
  const status = !r.recognized ? "UNRECOGNIZED CONTRACT" : r.valid ? "OK" : "CONTRACT DRIFT";
  const lines = [
    `[carrier-check] schema: ${r.schema ?? "(missing)"}`,
    `[carrier-check] status: ${status}`,
    `[carrier-check] recognized: ${r.recognized}`,
    `[carrier-check] valid: ${r.valid}`,
  ];
  for (const e of r.errors) {
    lines.push(`[carrier-check] error: ${e.code}${e.path ? ` (${e.path})` : ""}: ${e.message}`);
  }
  lines.push(`[carrier-check] artifact: ${r.carrier_path}`);
  return lines.join("\n");
}
