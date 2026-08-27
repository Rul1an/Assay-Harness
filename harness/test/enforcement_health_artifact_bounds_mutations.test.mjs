import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_CARRIER_FILE_BYTES,
  MAX_PROVENANCE_FILE_BYTES,
  assertExactPromotionEntries,
  materializePromotionArtifacts,
  streamResponseToFile,
} from "../dist/enforcement_health_artifact.js";

const DIST = fileURLToPath(new URL("../dist/enforcement_health_artifact.js", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "eh-artifact-mut-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const CARRIER = Buffer.from('{"schema":"assay.enforcement_health.v1"}\n');
const PROVENANCE = Buffer.from('{"schema":"suite.recipe_provenance.v0"}\n');
const STREAM_MAX = 64;
const LYING_DECLARED = 16;
const LYING_BODY = Buffer.alloc(40, 4);
const ABSOLUTE_BODY = Buffer.alloc(STREAM_MAX + 16, 1);

const HEADER_CAP = `    if (declared > maxCompressedBytes) {
        throw new Error(\`Content-Length \${declared} exceeds compressed cap \${maxCompressedBytes}\`);
    }`;
const STREAM_CAP = `            if (total > maxCompressedBytes) {
                throw new Error(\`compressed stream over cap \${maxCompressedBytes}\`);
            }`;
const DECLARED_CAP = `            if (total > declared) {
                throw new Error("compressed stream exceeds declared Content-Length");
            }`;
const EXPANDED_CAP = `    if (carrier.length > MAX_CARRIER_FILE_BYTES) {
        throw new Error("carrier exceeds expanded cap");
    }
    if (provenance.length > MAX_PROVENANCE_FILE_BYTES) {
        throw new Error("provenance exceeds expanded cap");
    }`;
const EXACT_ENTRY_FN = `export function assertExactPromotionEntries(names) {
    const seen = new Set();
    for (const name of names) {
        if (name.startsWith("/") || name.startsWith("\\\\")) {
            throw new Error(\`absolute path: \${name}\`);
        }
        if (name.includes("\\0") || name.includes("/") || name.includes("\\\\")) {
            throw new Error(\`unsafe separator in \${name}\`);
        }
        if (name.includes("..")) {
            throw new Error(\`traversal path: \${name}\`);
        }
        if (seen.has(name)) {
            throw new Error(\`duplicate entry: \${name}\`);
        }
        seen.add(name);
    }
    if (names.length !== REQUIRED_ARTIFACT_ENTRIES.length ||
        !REQUIRED_ARTIFACT_ENTRIES.every((entry) => seen.has(entry))) {
        throw new Error(\`exact two root entries required; extra or missing: \${names.join(",")}\`);
    }
    return [...REQUIRED_ARTIFACT_ENTRIES];
}`;

function dest() {
  return join(mkdtempSync(join(ROOT, "case-")), "artifact.zip");
}

function files(overrides = {}) {
  return {
    "enforcement-health.json": CARRIER,
    "recipe.provenance.json": PROVENANCE,
    ...overrides,
  };
}

function ioFrom(fileMap, writeStream = streamResponseToFile) {
  return {
    writeStream,
    listEntries: async () => Object.keys(fileMap),
    extractEntry: async (_zip, name) => {
      const buf = fileMap[name];
      if (!buf) throw new Error(`missing ${name}`);
      return buf;
    },
  };
}

function lyingSmallResponse() {
  return new Response(LYING_BODY, { headers: { "content-length": String(LYING_DECLARED) } });
}

function absoluteOverResponse() {
  return new Response(ABSOLUTE_BODY, { headers: { "content-length": String(ABSOLUTE_BODY.length) } });
}

function mustEdit(source, snippet, replacement) {
  assert.notEqual(source.indexOf(snippet), -1, "production snippet missing; tsc output drifted");
  return source.replace(snippet, replacement);
}

async function loadScratch(mutate) {
  const original = readFileSync(DIST, "utf8");
  const next = mutate(original);
  assert.notEqual(next, original, "scratch mutation must change production bytes");
  const dest = join(mkdtempSync(join(ROOT, "scratch-")), "enforcement_health_artifact.js");
  writeFileSync(dest, next);
  return import(pathToFileURL(dest).href);
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
      STREAM_MAX,
    ),
    /content-length/i,
  );
});

test("mutation: Content-Length over the absolute cap fails closed without reading the body", async () => {
  await mustReject(
    "Content-Length over cap",
    () => streamResponseToFile(
      new Response(
        new ReadableStream({
          pull() {
            throw new Error("body must not be read when Content-Length is over cap");
          },
        }),
        { headers: { "content-length": String(STREAM_MAX + 1) } },
      ),
      dest(),
      STREAM_MAX,
    ),
    /content-length|compressed cap/i,
  );
});

test("mutation: compressed stream over the absolute cap fails closed", async () => {
  await mustReject(
    "stream over cap",
    () => streamResponseToFile(absoluteOverResponse(), dest(), STREAM_MAX),
    /content-length|compressed cap/i,
  );
});

test("lying Content-Length under the compressed cap fails independently of the absolute cap", async () => {
  assert.ok(LYING_BODY.length < STREAM_MAX);
  assert.ok(LYING_BODY.length > LYING_DECLARED);
  await mustReject(
    "lying small Content-Length",
    () => streamResponseToFile(lyingSmallResponse(), dest(), STREAM_MAX),
    /declared Content-Length/i,
  );
});

test("mutation: oversized carrier fails closed", async () => {
  await mustReject(
    "oversized carrier",
    () => materializePromotionArtifacts({
      response: new Response(Buffer.alloc(8), { headers: { "content-length": "8" } }),
      dest: dest(),
      io: ioFrom(files({ "enforcement-health.json": Buffer.alloc(MAX_CARRIER_FILE_BYTES + 1, 2) })),
    }),
    /carrier|expanded cap/i,
  );
});

test("mutation: oversized provenance fails closed", async () => {
  await mustReject(
    "oversized provenance",
    () => materializePromotionArtifacts({
      response: new Response(Buffer.alloc(8), { headers: { "content-length": "8" } }),
      dest: dest(),
      io: ioFrom(files({ "recipe.provenance.json": Buffer.alloc(MAX_PROVENANCE_FILE_BYTES + 1, 3) })),
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

test("scratch: deleting the compressed cap accepts an over-cap zip that a lying-small body still rejects", async () => {
  const mutated = await loadScratch((src) => mustEdit(mustEdit(src, HEADER_CAP, ""), STREAM_CAP, ""));
  await mutated.streamResponseToFile(absoluteOverResponse(), dest(), STREAM_MAX);
  await assert.rejects(
    () => mutated.streamResponseToFile(lyingSmallResponse(), dest(), STREAM_MAX),
    /declared Content-Length/i,
  );
});

test("scratch: deleting the declared-length check accepts a lying-small body that an over-cap zip still rejects", async () => {
  const mutated = await loadScratch((src) => mustEdit(src, DECLARED_CAP, ""));
  await mutated.streamResponseToFile(lyingSmallResponse(), dest(), STREAM_MAX);
  await assert.rejects(
    () => mutated.streamResponseToFile(absoluteOverResponse(), dest(), STREAM_MAX),
    /content-length|compressed cap/i,
  );
});

test("scratch: deleting the expanded caps accepts an oversized carrier the production funnel rejects", async () => {
  const mutated = await loadScratch((src) => mustEdit(src, EXPANDED_CAP, ""));
  const oversized = Buffer.alloc(MAX_CARRIER_FILE_BYTES + 1, 2);
  const got = await mutated.materializePromotionArtifacts({
    response: new Response(Buffer.alloc(8), { headers: { "content-length": "8" } }),
    dest: dest(),
    io: ioFrom(files({ "enforcement-health.json": oversized }), mutated.streamResponseToFile),
  });
  assert.equal(got["enforcement-health.json"].length, oversized.length);
});

test("scratch: deleting the exact-entry check accepts an extra archive name the production funnel rejects", async () => {
  const mutated = await loadScratch((src) => mustEdit(src, EXACT_ENTRY_FN, "export function assertExactPromotionEntries(names) {\n    return names;\n}"));
  mutated.assertExactPromotionEntries(["enforcement-health.json", "recipe.provenance.json", "extra.txt"]);
  const extra = { ...files(), "extra.txt": Buffer.from("x") };
  const got = await mutated.materializePromotionArtifacts({
    response: new Response(Buffer.alloc(8), { headers: { "content-length": "8" } }),
    dest: dest(),
    io: {
      writeStream: mutated.streamResponseToFile,
      listEntries: async () => ["enforcement-health.json", "recipe.provenance.json", "extra.txt"],
      extractEntry: async (_zip, name) => extra[name],
    },
  });
  assert.equal(got["enforcement-health.json"].length, CARRIER.length);
});

test("scratch no-op: comment-only edit keeps every production reject green", async () => {
  const mutated = await loadScratch((src) => mustEdit(src, "let total = 0;", "let total = 0; // no-op mutation control"));
  await assert.rejects(() => mutated.streamResponseToFile(absoluteOverResponse(), dest(), STREAM_MAX), /content-length|compressed cap/i);
  await assert.rejects(() => mutated.streamResponseToFile(lyingSmallResponse(), dest(), STREAM_MAX), /declared Content-Length/i);
  assert.throws(
    () => mutated.assertExactPromotionEntries(["enforcement-health.json", "recipe.provenance.json", "extra.txt"]),
    /exact|extra/i,
  );
  await assert.rejects(
    () => mutated.materializePromotionArtifacts({
      response: new Response(Buffer.alloc(8), { headers: { "content-length": "8" } }),
      dest: dest(),
      io: ioFrom(files({ "enforcement-health.json": Buffer.alloc(MAX_CARRIER_FILE_BYTES + 1, 2) }), mutated.streamResponseToFile),
    }),
    /carrier|expanded cap/i,
  );
});
