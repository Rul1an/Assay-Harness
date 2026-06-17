import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RECIPE_PROVENANCE_SCHEMA,
  validateRecipeProvenance,
} from "../dist/suite_recipe_provenance.js";

// A valid base provenance (matches the H-next-2 hermetic recipe shape).
const base = () => ({
  schema: "suite.recipe_provenance.v0",
  recipe: "assay_mcp_inventory_e2e",
  hosted_run: "27682711427",
  runner_os: "ubuntu-latest",
  hosted: true,
  ambient_scan: false,
  assay: {
    version: "v3.27.0",
    binary_digest: "sha256:52a30b3f8156063f0bc2d2e9f306d7e9a432d71414d5fdba460d74dd5b2d26e5",
    command: "assay mcp inventory --no-process-scan --out /tmp/inventory.json",
  },
  fixture: { path: "harness/fixtures/suite-compatibility/mcp-config/claude_desktop_config.json", digest: "sha256:9f2ebcb98e98331f12e816b0805db122d631e6e420822927a43bdbd499aa04fa" },
  artifact: { path: "carriers/assay.mcp_server_inventory.v0.json", digest: "sha256:ded545cec4188e79c184f0a162e255661eb09d000b710d0b6a6e5b52566586ad" },
  harness: { version: "0.8.0", command: "assay-harness carrier inventory --carrier carriers/assay.mcp_server_inventory.v0.json" },
  result: { exit_code: 0, classification: "success" },
});
const codes = (raw) => validateRecipeProvenance(raw).errors.map((e) => e.code);

test("schema constant", () => {
  assert.equal(RECIPE_PROVENANCE_SCHEMA, "suite.recipe_provenance.v0");
});

test("a provenance WITHOUT release_asset is valid (v0 / H-next-3 backward-compat)", () => {
  const r = validateRecipeProvenance(base());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("a provenance WITH a well-formed release_asset is valid", () => {
  const p = base();
  p.release_asset = {
    path: "assay-v3.27.0-x86_64-unknown-linux-gnu.tar.gz",
    digest: "sha256:079492e5b5840accabd3c685fbc9cdfbccb324fc32e39490ec8cca39758072bc",
  };
  const r = validateRecipeProvenance(p);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("release_asset present but missing digest is rejected", () => {
  const p = base();
  p.release_asset = { path: "assay-v3.27.0-x86_64-unknown-linux-gnu.tar.gz" };
  assert.ok(codes(p).includes("PROVENANCE_FIELD_INVALID"));
});

test("release_asset present with empty digest is rejected", () => {
  const p = base();
  p.release_asset = { path: "x.tar.gz", digest: "" };
  assert.ok(codes(p).includes("PROVENANCE_FIELD_INVALID"));
});

test("release_asset present as a non-object is rejected", () => {
  const p = base();
  p.release_asset = "sha256:079492e5";
  assert.ok(codes(p).includes("PROVENANCE_FIELD_INVALID"));
});

test("the rest of the shape is still enforced (missing assay -> invalid)", () => {
  const p = base();
  delete p.assay;
  assert.ok(codes(p).includes("PROVENANCE_FIELD_INVALID"));
});
