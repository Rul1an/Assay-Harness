import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_CARRIER_FILE_BYTES,
  materializePromotionArtifacts,
  productionZipIo,
} from "../dist/enforcement_health_artifact.js";

const DIST = fileURLToPath(new URL("../dist/enforcement_health_artifact.js", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "eh-prod-zip-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const CARRIER = Buffer.from('{"schema":"assay.enforcement_health.v1"}\n');
const PROVENANCE = Buffer.from('{"schema":"suite.recipe_provenance.v0"}\n');
const LIST_UNZIP = `async listEntries(zipPath) {
            const listed = spawnSync("unzip", ["-Z1", zipPath], {
                encoding: "utf8",
                timeout: ZIP_PROCESS_TIMEOUT_MS,
                killSignal: "SIGKILL",
                stdio: ["ignore", "pipe", "pipe"],
                maxBuffer: MAX_ZIP_LIST_BYTES,
            });
            assertZipProcessSucceeded(listed, "zip list", "zip list failed");
            return listed.stdout.split("\\n").map((line) => line.trim()).filter(Boolean);
        }`;
const EXTRACT_UNZIP = `async extractEntry(zipPath, name, maxBytes) {
            const extracted = spawnSync("unzip", ["-p", zipPath, name], {
                encoding: "buffer",
                timeout: ZIP_PROCESS_TIMEOUT_MS,
                killSignal: "SIGKILL",
                stdio: ["ignore", "pipe", "pipe"],
                maxBuffer: maxBytes,
            });
            assertZipProcessSucceeded(extracted, "zip extract", \`\${name} exceeds expanded cap\`);
            const buf = Buffer.isBuffer(extracted.stdout) ? extracted.stdout : Buffer.from(extracted.stdout);
            if (buf.length > maxBytes) {
                throw new Error(\`\${name} exceeds expanded cap\`);
            }
            return buf;
        }`;
const LIST_BYPASS = `async listEntries() {
            return ["enforcement-health.json", "recipe.provenance.json"];
        }`;
const EXTRACT_WRONG = `async extractEntry() {
            return Buffer.from("wrong-bytes");
        }`;

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function storeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf, data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,
    cd,
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
}

const VALID_ZIP = storeZip([
  ["enforcement-health.json", CARRIER],
  ["recipe.provenance.json", PROVENANCE],
]);
const EXTRA_ZIP = storeZip([
  ["enforcement-health.json", CARRIER],
  ["recipe.provenance.json", PROVENANCE],
  ["extra.txt", Buffer.from("x")],
]);
const NESTED_ZIP = storeZip([
  ["nested/enforcement-health.json", CARRIER],
  ["recipe.provenance.json", PROVENANCE],
]);
const OVERSIZE_ZIP = storeZip([
  ["enforcement-health.json", Buffer.alloc(MAX_CARRIER_FILE_BYTES + 1, 0x61)],
  ["recipe.provenance.json", PROVENANCE],
]);
const CORRUPT_ZIP = Buffer.from("not-a-zip");

function dest() {
  return join(mkdtempSync(join(ROOT, "case-")), "artifact.zip");
}

function zipResponse(body) {
  return new Response(body, { headers: { "content-length": String(body.length) } });
}

function materialize(body, io = productionZipIo()) {
  return materializePromotionArtifacts({ response: zipResponse(body), dest: dest(), io });
}

function mustEdit(source, snippet, replacement) {
  assert.notEqual(source.indexOf(snippet), -1, "production snippet missing; tsc output drifted");
  return source.replace(snippet, replacement);
}

async function loadScratch(mutate) {
  const original = readFileSync(DIST, "utf8");
  const next = mutate(original);
  assert.notEqual(next, original, "scratch mutation must change production bytes");
  const scratch = join(mkdtempSync(join(ROOT, "scratch-")), "enforcement_health_artifact.mjs");
  writeFileSync(scratch, next);
  return import(pathToFileURL(scratch).href);
}

async function withBlockingUnzip(body) {
  const bin = mkdtempSync(join(ROOT, "fake-bin-"));
  const unzip = join(bin, "unzip");
  writeFileSync(unzip, "#!/bin/sh\nsleep 2\n");
  chmodSync(unzip, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    await body();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

test("production unzip is present", () => {
  const probe = spawnSync("unzip", ["-v"], { encoding: "utf8" });
  if (probe.error) {
    throw new Error(`production unzip must be present (${probe.error.message}); refusing to skip`);
  }
  assert.equal(probe.status, 0);
});

test("productionZipIo bounds a blocked unzip listing", { timeout: 5000 }, async () => {
  await withBlockingUnzip(async () => {
    const started = Date.now();
    await assert.rejects(
      () => productionZipIo().listEntries(dest()),
      /zip list timed out after 1000ms/,
    );
    assert.ok(Date.now() - started < 1800, "listing must fail before the fake unzip exits");
  });
});

test("productionZipIo bounds a blocked unzip extraction", { timeout: 5000 }, async () => {
  await withBlockingUnzip(async () => {
    const started = Date.now();
    await assert.rejects(
      () => productionZipIo().extractEntry(dest(), "enforcement-health.json", MAX_CARRIER_FILE_BYTES),
      /zip extract timed out after 1000ms/,
    );
    assert.ok(Date.now() - started < 1800, "extraction must fail before the fake unzip exits");
  });
});

test("productionZipIo valid two-root zip roundtrips exact bytes", async () => {
  const io = productionZipIo();
  const zipPath = dest();
  writeFileSync(zipPath, VALID_ZIP);
  assert.deepEqual(await io.listEntries(zipPath), ["enforcement-health.json", "recipe.provenance.json"]);
  assert.deepEqual(await io.extractEntry(zipPath, "enforcement-health.json", MAX_CARRIER_FILE_BYTES), CARRIER);
  assert.deepEqual(await io.extractEntry(zipPath, "recipe.provenance.json", MAX_CARRIER_FILE_BYTES), PROVENANCE);
  const got = await materialize(VALID_ZIP);
  assert.deepEqual(got["enforcement-health.json"], CARRIER);
  assert.deepEqual(got["recipe.provenance.json"], PROVENANCE);
});

test("productionZipIo rejects an extra root entry", async () => {
  await assert.rejects(() => materialize(EXTRA_ZIP), /exact|extra/i);
});

test("productionZipIo rejects a nested archive entry", async () => {
  await assert.rejects(() => materialize(NESTED_ZIP), /unsafe separator|exact|extra/i);
});

test("productionZipIo rejects a 64KiB+1 expanded carrier", async () => {
  await assert.rejects(() => materialize(OVERSIZE_ZIP), /exceeds expanded cap|carrier/i);
});

test("productionZipIo rejects a corrupt zip", async () => {
  await assert.rejects(() => materialize(CORRUPT_ZIP), /zip list failed|cannot find|invalid|end-of-central|missing/i);
});

test("scratch: bypassing unzip listEntries accepts an extra entry the production funnel rejects", async () => {
  const mutated = await loadScratch((src) => mustEdit(src, LIST_UNZIP, LIST_BYPASS));
  const got = await materialize(EXTRA_ZIP, mutated.productionZipIo());
  assert.deepEqual(got["enforcement-health.json"], CARRIER);
});

test("scratch: extractEntry that skips unzip returns wrong bytes the production funnel rejects", async () => {
  const mutated = await loadScratch((src) => mustEdit(src, EXTRACT_UNZIP, EXTRACT_WRONG));
  const got = await materialize(VALID_ZIP, mutated.productionZipIo());
  assert.deepEqual(got["enforcement-health.json"], Buffer.from("wrong-bytes"));
  assert.notDeepEqual(got["enforcement-health.json"], CARRIER);
});

test("scratch no-op: comment-only unzip edit keeps every production pin green", async () => {
  const mutated = await loadScratch((src) => mustEdit(
    src,
    `const listed = spawnSync("unzip", ["-Z1", zipPath], {`,
    `const listed = spawnSync("unzip", ["-Z1", zipPath], { // no-op mutation control`,
  ));
  const io = mutated.productionZipIo();
  const got = await materialize(VALID_ZIP, io);
  assert.deepEqual(got["enforcement-health.json"], CARRIER);
  assert.deepEqual(got["recipe.provenance.json"], PROVENANCE);
  await assert.rejects(() => materialize(EXTRA_ZIP, io), /exact|extra/i);
  await assert.rejects(() => materialize(NESTED_ZIP, io), /unsafe separator|exact|extra/i);
  await assert.rejects(() => materialize(OVERSIZE_ZIP, io), /exceeds expanded cap|carrier/i);
  await assert.rejects(() => materialize(CORRUPT_ZIP, io), /zip list failed|cannot find|invalid|end-of-central|missing/i);
});
