import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  MAX_ARTIFACT_ZIP_BYTES,
  MAX_CARRIER_FILE_BYTES,
  MAX_PROVENANCE_FILE_BYTES,
  REQUIRED_ARTIFACT_ENTRIES,
  assertExactPromotionEntries,
  materializePromotionArtifacts,
  streamResponseToFile,
} from "../dist/enforcement_health_artifact.js";

const ROOT = mkdtempSync(join(tmpdir(), "eh-artifact-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const CARRIER = Buffer.from('{"schema":"assay.enforcement_health.v1"}\n');
const PROVENANCE = Buffer.from('{"schema":"suite.recipe_provenance.v0"}\n');

function dest() {
  return join(mkdtempSync(join(ROOT, "case-")), "artifact.zip");
}

function responseOf(body, headers) {
  return new Response(body, { headers });
}

function ioFrom(files) {
  return {
    writeStream: streamResponseToFile,
    listEntries: async () => Object.keys(files),
    extractEntry: async (_zip, name, maxBytes) => {
      const buf = files[name];
      if (!buf) throw new Error(`missing ${name}`);
      if (buf.length > maxBytes) throw new Error(`${name} exceeds expanded cap`);
      return buf;
    },
  };
}

test("valid two-file control passes under compressed and expanded ceilings", async () => {
  assert.deepEqual(REQUIRED_ARTIFACT_ENTRIES, ["enforcement-health.json", "recipe.provenance.json"]);
  const files = {
    "enforcement-health.json": CARRIER,
    "recipe.provenance.json": PROVENANCE,
  };
  const zip = dest();
  const body = Buffer.alloc(32, 7);
  const materialized = await materializePromotionArtifacts({
    response: responseOf(body, { "content-length": String(body.length) }),
    dest: zip,
    io: ioFrom(files),
  });
  assert.deepEqual(materialized["enforcement-health.json"], CARRIER);
  assert.deepEqual(materialized["recipe.provenance.json"], PROVENANCE);
  assert.ok(readFileSync(zip).length <= MAX_ARTIFACT_ZIP_BYTES);
  assert.ok(CARRIER.length <= MAX_CARRIER_FILE_BYTES);
  assert.ok(PROVENANCE.length <= MAX_PROVENANCE_FILE_BYTES);
});

test("no-op survives: repeating a valid extract yields the same two files", async () => {
  assert.deepEqual(
    assertExactPromotionEntries(["recipe.provenance.json", "enforcement-health.json"]),
    ["enforcement-health.json", "recipe.provenance.json"],
  );
  const first = assertExactPromotionEntries(["enforcement-health.json", "recipe.provenance.json"]);
  const second = assertExactPromotionEntries(first);
  assert.deepEqual(first, second);
});
