import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkCarrierContract } from "../dist/carrier_drift.js";
import { getCarrierAdapter, registeredCarrierSchemas } from "../dist/carrier_registry.js";
import { SUPPLY_CHAIN_CONFORMANCE_SCHEMA } from "../dist/carrier_supply_chain.js";
import { RENDER_SAFETY_CONFORMANCE_SCHEMA } from "../dist/carrier_render_safety.js";
import { TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA } from "../dist/carrier_token_passthrough.js";
import { ENFORCEMENT_HEALTH_V1_SCHEMA } from "../dist/carrier_enforcement_health.js";

const fx = (sub, name) => fileURLToPath(new URL(`../fixtures/${sub}/${name}`, import.meta.url));
const CLI = "dist/cli.js";

// Each registered schema mapped to a clean golden fixture (the producer-shaped bytes).
const GOLDENS = {
  [SUPPLY_CHAIN_CONFORMANCE_SCHEMA]: fx("supply-chain-conformance", "pass.conformance.json"),
  [RENDER_SAFETY_CONFORMANCE_SCHEMA]: fx("render-safety-conformance", "clean.conformance.json"),
  [TOKEN_PASSTHROUGH_CONFORMANCE_SCHEMA]: fx("token-passthrough-conformance", "clean.conformance.json"),
  [ENFORCEMENT_HEALTH_V1_SCHEMA]: fx("enforcement-health-conformance", "active-no-probe.conformance.json"),
};

test("registry completeness: every registered schema resolves an adapter and has a golden", () => {
  const schemas = registeredCarrierSchemas();
  assert.ok(schemas.length >= 3, `expected >= 3 registered schemas, got ${schemas.length}`);
  for (const s of schemas) {
    assert.ok(getCarrierAdapter(s), `adapter missing for ${s}`);
    assert.ok(GOLDENS[s], `golden fixture not mapped for ${s} (drift-test must cover every registered schema)`);
  }
});

test("each registered carrier golden is recognized and contract-valid (no drift)", () => {
  for (const [schema, path] of Object.entries(GOLDENS)) {
    const r = checkCarrierContract(path);
    assert.equal(r.recognized, true, `${schema} not recognized`);
    assert.equal(r.valid, true, `${schema} invalid: ${JSON.stringify(r.errors)}`);
    assert.equal(r.schema, schema);
  }
});

test("an unknown schema id is unrecognized (drift), never silently accepted", () => {
  const r = checkCarrierContract(fx("supply-chain-conformance", "wrong-schema.conformance.json"));
  assert.equal(r.recognized, false);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === "CARRIER_SCHEMA_UNRECOGNIZED"));
});

test("a valid-shape carrier that fails its gate is still contract-valid (check != gate)", () => {
  // a render-safety leak carrier is well-formed (contract OK) but fails its gate verb.
  const r = checkCarrierContract(fx("render-safety-conformance", "leak.conformance.json"));
  assert.equal(r.recognized, true);
  assert.equal(r.valid, true);
});

function runCheck(...cliArgs) {
  return spawnSync(process.execPath, [CLI, "carrier", "check", ...cliArgs], { encoding: "utf8" });
}

test("CLI carrier check: recognized+valid -> 0 (incl. a gate-failing but well-formed carrier)", () => {
  assert.equal(runCheck("--carrier", GOLDENS[SUPPLY_CHAIN_CONFORMANCE_SCHEMA]).status, 0);
  assert.equal(runCheck("--carrier", fx("render-safety-conformance", "leak.conformance.json")).status, 0);
});

test("CLI carrier check: unknown schema -> 3, missing file -> 2, invalid --format -> 2", () => {
  assert.equal(runCheck("--carrier", fx("token-passthrough-conformance", "wrong-schema.conformance.json")).status, 3);
  assert.equal(runCheck("--carrier", "/nonexistent/x.json").status, 2);
  assert.equal(runCheck("--carrier", GOLDENS[SUPPLY_CHAIN_CONFORMANCE_SCHEMA], "--format", "xml").status, 2);
});
