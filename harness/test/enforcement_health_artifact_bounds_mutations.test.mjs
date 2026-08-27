import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_ARTIFACT_ZIP_BYTES,
  MAX_CARRIER_FILE_BYTES,
  MAX_PROVENANCE_FILE_BYTES,
  assertExactPromotionEntries,
  materializePromotionArtifacts,
  streamResponseToFile,
} from "../dist/enforcement_health_artifact.js";

const SRC = fileURLToPath(new URL("../src/enforcement_health_artifact.ts", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "eh-artifact-mut-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const CARRIER = Buffer.from('{"schema":"assay.enforcement_health.v1"}\n');
const PROVENANCE = Buffer.from('{"schema":"suite.recipe_provenance.v0"}\n');

function dest() {
  return join(mkdtempSync(join(ROOT, "case-")), "artifact.zip");
}

function unreadOversizeBody() {
  return new ReadableStream({
    pull() {
      throw new Error("body must not be read when Content-Length is over cap");
    },
  });
}

function files(overrides = {}) {
  return {
    "enforcement-health.json": CARRIER,
    "recipe.provenance.json": PROVENANCE,
    ...overrides,
  };
}

function ioFrom(fileMap) {
  return {
    writeStream: streamResponseToFile,
    listEntries: async () => Object.keys(fileMap),
    extractEntry: async (_zip, name) => {
      const buf = fileMap[name];
      if (!buf) throw new Error(`missing ${name}`);
      return buf;
    },
  };
}

async function mustReject(label, fn, pattern) {
  await assert.rejects(fn, pattern, label);
}

test("mutation: absent Content-Length fails closed before materialization", async () => {
  await mustReject(
    "absent Content-Length",
    () => streamResponseToFile(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
            controller.close();
          },
        }),
        { headers: {} },
      ),
      dest(),
      MAX_ARTIFACT_ZIP_BYTES,
    ),
    /content-length/i,
  );
});

test("mutation: lying Content-Length over cap fails closed without reading the body", async () => {
  const declared = String(MAX_ARTIFACT_ZIP_BYTES + 1);
  await mustReject(
    "Content-Length over cap",
    () => streamResponseToFile(
      new Response(unreadOversizeBody(), { headers: { "content-length": declared } }),
      dest(),
      MAX_ARTIFACT_ZIP_BYTES,
    ),
    /content-length|compressed cap/i,
  );
});

test("mutation: compressed stream over cap fails closed", async () => {
  const declared = String(MAX_ARTIFACT_ZIP_BYTES);
  const body = Buffer.alloc(MAX_ARTIFACT_ZIP_BYTES + 16, 1);
  await mustReject(
    "stream over cap",
    () => streamResponseToFile(
      new Response(body, { headers: { "content-length": declared } }),
      dest(),
      MAX_ARTIFACT_ZIP_BYTES,
    ),
    /stream|compressed cap/i,
  );
});

test("mutation: oversized carrier fails closed", async () => {
  const oversized = Buffer.alloc(MAX_CARRIER_FILE_BYTES + 1, 2);
  await mustReject(
    "oversized carrier",
    () => materializePromotionArtifacts({
      response: new Response(Buffer.alloc(8), { headers: { "content-length": "8" } }),
      dest: dest(),
      io: ioFrom(files({ "enforcement-health.json": oversized })),
    }),
    /carrier|expanded cap/i,
  );
});

test("mutation: oversized provenance fails closed", async () => {
  const oversized = Buffer.alloc(MAX_PROVENANCE_FILE_BYTES + 1, 3);
  await mustReject(
    "oversized provenance",
    () => materializePromotionArtifacts({
      response: new Response(Buffer.alloc(8), { headers: { "content-length": "8" } }),
      dest: dest(),
      io: ioFrom(files({ "recipe.provenance.json": oversized })),
    }),
    /provenance|expanded cap/i,
  );
});

test("mutation: duplicate name fails closed", () => {
  assert.throws(
    () => assertExactPromotionEntries(["enforcement-health.json", "enforcement-health.json", "recipe.provenance.json"]),
    /duplicate/i,
  );
});

test("mutation: ../ path fails closed", () => {
  assert.throws(
    () => assertExactPromotionEntries(["../enforcement-health.json", "recipe.provenance.json"]),
    /traversal|\.\.|unsafe/i,
  );
});

test("mutation: absolute path fails closed", () => {
  assert.throws(
    () => assertExactPromotionEntries(["/tmp/enforcement-health.json", "recipe.provenance.json"]),
    /absolute|unsafe/i,
  );
});

test("mutation: extra entry fails closed", () => {
  assert.throws(
    () => assertExactPromotionEntries(["enforcement-health.json", "recipe.provenance.json", "extra.txt"]),
    /exact|extra/i,
  );
});

test("mutation: deleted compressed cap is observed on the production path", () => {
  const src = readFileSync(SRC, "utf8");
  assert.match(src, /MAX_ARTIFACT_ZIP_BYTES/);
  assert.match(src, /content-length/i);
  assert.match(src, /total > maxCompressedBytes|total > max/);
});

test("mutation: deleted expanded cap is observed on the production path", () => {
  const src = readFileSync(SRC, "utf8");
  assert.match(src, /MAX_CARRIER_FILE_BYTES/);
  assert.match(src, /MAX_PROVENANCE_FILE_BYTES/);
  assert.match(src, /buf\.length > maxBytes|length > max/);
});

test("mutation: deleted exact-entry check is observed on the production path", () => {
  const src = readFileSync(SRC, "utf8");
  assert.match(src, /assertExactPromotionEntries/);
  assert.match(src, /enforcement-health\.json/);
  assert.match(src, /recipe\.provenance\.json/);
});
