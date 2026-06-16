/**
 * Conformance carrier registry — one adapter per frozen schema id.
 *
 * Generic infrastructure, carrier-specific adapters. The Harness consumes a
 * conformance carrier by its `schema` id, validates the frozen shape, gates on
 * the producer-owned status, and projects. A schema id with no registered
 * adapter is rejected by the caller (artifact_contract): the Harness never
 * silently passes a carrier it does not understand. New carriers (render-safety,
 * token-passthrough) register here without changing the dispatch shape.
 */

import {
  SUPPLY_CHAIN_CONFORMANCE_SCHEMA,
  validateSupplyChainConformance,
  type CarrierValidationError,
} from "./carrier_supply_chain.js";

export interface CarrierAdapter {
  /** The exact frozen schema id this adapter consumes. */
  schema: string;
  /** Validate a parsed payload against the adapter's frozen shape. */
  validate: (raw: unknown) => { valid: boolean; errors: CarrierValidationError[] };
}

const ADAPTERS: Record<string, CarrierAdapter> = {
  [SUPPLY_CHAIN_CONFORMANCE_SCHEMA]: {
    schema: SUPPLY_CHAIN_CONFORMANCE_SCHEMA,
    validate: validateSupplyChainConformance,
  },
};

/** Return the adapter for a schema id, or `undefined` when none is registered. */
export function getCarrierAdapter(schemaId: string): CarrierAdapter | undefined {
  // Own-property lookup only: an arbitrary schema id must never resolve to an
  // inherited Object.prototype member (e.g. "toString", "constructor").
  return Object.prototype.hasOwnProperty.call(ADAPTERS, schemaId) ? ADAPTERS[schemaId] : undefined;
}

/** Schema ids with a registered adapter (for usage/help and tests). */
export function registeredCarrierSchemas(): string[] {
  return Object.keys(ADAPTERS);
}

/** Read a carrier's `schema` id without fully validating it (for dispatch / drift checks). */
export function peekCarrierSchema(raw: unknown): string | undefined {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const s = (raw as Record<string, unknown>).schema;
    if (typeof s === "string") return s;
  }
  return undefined;
}
