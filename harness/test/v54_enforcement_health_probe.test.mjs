import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/probe-v54-enforcement-health.mjs", import.meta.url));
const MATRIX = fileURLToPath(new URL("../suite-compatibility.json", import.meta.url));
const COMPAT_DOC = fileURLToPath(new URL("../../docs/ASSAY_COMPATIBILITY.md", import.meta.url));
const README = fileURLToPath(new URL("../../README.md", import.meta.url));

const PINNED_SCHEMA = "assay.enforcement_health.v1";
const DOTTED_SCHEMA = "assay.enforcement.health.v1";
const PINNED_ASSET_DIGEST = "sha256:352cd390dc59fb5adacecae5adf51976419f18ae50918f8f1504952869e94ad3";
const PINNED_PEEL = "bbb5e7fe4b03bc6160d18e2966e75a7586c062ef";
const PINNED_MATRIX_DIGEST = "sha256:ce7640673f9b6f1160e88378aea9f64ef77ae98074fdb067cf21492fcdfd8ea7";
const LAYOUT = "assay-v5.4.0-x86_64-unknown-linux-gnu";

const ACTIVE_HEALTH = {
  schema: PINNED_SCHEMA,
  status: "active",
  mechanism: "landlock",
  scope: "tcp_connect_landlock_port",
  policy_semantics: "allowlist",
  landlock: {
    abi: 4,
    handled_access_net: ["connect_tcp"],
    allowed_connect_tcp_ports: [443],
    no_new_privs_confirmed: true,
    restrict_self_confirmed: true,
  },
  probe: {
    kind: "real_block",
    transport: "ipv4",
    blocked_action: "tcp_connect",
    blocked_port: 4444,
    blocked_errno: "EACCES",
    listener_reached: false,
  },
  non_claims: ["no ip or cidr enforcement"],
};

function sha256File(path) {
  return "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "v54-enforcement-health-"));
}

function packAsset(dir, { assaySource, layout = LAYOUT } = {}) {
  const root = join(dir, "pack");
  if (assaySource !== undefined) {
    mkdirSync(join(root, layout), { recursive: true });
    const bin = join(root, layout, "assay");
    writeFileSync(bin, assaySource);
    chmodSync(bin, 0o755);
  } else {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.txt"), "empty archive\n");
  }
  const asset = join(dir, `${LAYOUT}.tar.gz`);
  const packed = assaySource === undefined ? "." : layout;
  const tar = spawnSync("tar", ["-czf", asset, "-C", root, packed], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  return { asset, digest: sha256File(asset) };
}

function fakeAssay({ health, exit = 0, sleepMs = 0, argvPath, extraBytes = 0 } = {}) {
  const payload = typeof health === "string" ? health : JSON.stringify(health ?? ACTIVE_HEALTH);
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const i = args.indexOf("--enforcement-health");
const out = i >= 0 ? args[i + 1] : null;
${argvPath ? `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args));` : ""}
${sleepMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${sleepMs});` : ""}
if (out) {
  let body = ${JSON.stringify(payload)};
  ${extraBytes ? `body += "x".repeat(${extraBytes});` : ""}
  fs.writeFileSync(out, body);
}
process.exit(${exit});
`;
}

function runProbe(args, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    ...extra,
  });
}

function stageGreen(dir, { health, exit, sleepMs, extraBytes } = {}) {
  const argvPath = join(dir, "argv.json");
  const packed = packAsset(dir, {
    assaySource: fakeAssay({ health, exit, sleepMs, extraBytes, argvPath }),
  });
  const out = join(dir, "enforcement-health.json");
  const workdir = join(dir, "work");
  mkdirSync(workdir);
  return { ...packed, out, workdir, argvPath };
}

test("wrong digest fails closed before extraction", () => {
  const dir = tempDir();
  const { asset, out, workdir } = stageGreen(dir);
  const r = runProbe([
    "--asset", asset,
    "--expected-digest", PINNED_ASSET_DIGEST,
    "--out", out,
    "--workdir", workdir,
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /digest|sha256/i);
  assert.equal(existsSync(join(workdir, LAYOUT)), false, "must not extract before digest match");
  assert.equal(existsSync(out), false);
});

test("missing asset fails closed without a network fallback", () => {
  const dir = tempDir();
  const missing = join(dir, `${LAYOUT}.tar.gz`);
  const r = runProbe([
    "--asset", missing,
    "--expected-digest", PINNED_ASSET_DIGEST,
    "--out", join(dir, "health.json"),
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /missing|not found|ENOENT/i);
  assert.doesNotMatch(r.stderr, /download|github\.com\/Rul1an\/assay\/releases|curl|wget/i);
});

test("tarball without the assay binary fails closed", () => {
  const dir = tempDir();
  const { asset, digest } = packAsset(dir);
  const r = runProbe([
    "--asset", asset,
    "--expected-digest", digest,
    "--out", join(dir, "health.json"),
    "--workdir", join(dir, "work"),
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /binary|assay/i);
});

test("malformed producer output fails closed", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir } = stageGreen(dir, { health: "{not-json" });
  const r = runProbe(["--asset", asset, "--expected-digest", digest, "--out", out, "--workdir", workdir]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /malformed|JSON|parse/i);
});

test("wrong schema id fails closed, including the dotted lookalike", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir } = stageGreen(dir, {
    health: { ...ACTIVE_HEALTH, schema: DOTTED_SCHEMA },
  });
  const r = runProbe(["--asset", asset, "--expected-digest", digest, "--out", out, "--workdir", workdir]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /schema/i);
  assert.match(r.stderr, new RegExp(PINNED_SCHEMA.replaceAll(".", "\\.")));
});

test("nonzero producer exit fails closed even when it wrote a valid record", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir } = stageGreen(dir, { exit: 7 });
  const r = runProbe(["--asset", asset, "--expected-digest", digest, "--out", out, "--workdir", workdir]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /exit|nonzero|status/i);
});

test("oversized asset is refused before materialization", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir } = stageGreen(dir);
  const r = runProbe([
    "--asset", asset,
    "--expected-digest", digest,
    "--out", out,
    "--workdir", workdir,
    "--max-asset-bytes", "16",
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /cap|too large|max-asset/i);
  assert.equal(existsSync(join(workdir, LAYOUT)), false);
});

test("oversized producer output fails closed", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir } = stageGreen(dir, { extraBytes: 80 });
  const r = runProbe([
    "--asset", asset,
    "--expected-digest", digest,
    "--out", out,
    "--workdir", workdir,
    "--max-output-bytes", "32",
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /cap|too large|max-output/i);
});

test("producer timeout fails closed", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir } = stageGreen(dir, { sleepMs: 2000 });
  const r = runProbe([
    "--asset", asset,
    "--expected-digest", digest,
    "--out", out,
    "--workdir", workdir,
    "--timeout-ms", "150",
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /timeout/i);
});

test("two JSON records are not a best-effort pass", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir } = stageGreen(dir, {
    health: `${JSON.stringify(ACTIVE_HEALTH)}\n${JSON.stringify(ACTIVE_HEALTH)}\n`,
  });
  const r = runProbe(["--asset", asset, "--expected-digest", digest, "--out", out, "--workdir", workdir]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /exactly one|extra|surplus|trailing/i);
});

test("status=failed is truthful but not a clean Landlock result", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir } = stageGreen(dir, {
    health: {
      ...ACTIVE_HEALTH,
      status: "failed",
      probe: null,
      failure: { reason_code: "landlock_unavailable", detail: "host" },
    },
  });
  const r = runProbe(["--asset", asset, "--expected-digest", digest, "--out", out, "--workdir", workdir]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /failed|not clean|unavailable/i);
});

test("no-op control: digest-bound local asset with truthful active record is green", () => {
  const dir = tempDir();
  const { asset, digest, out, workdir, argvPath } = stageGreen(dir);
  assert.notEqual(digest, PINNED_ASSET_DIGEST, "local test bytes must not collide with the published digest");
  const beforeMatrix = readFileSync(MATRIX);
  const r = runProbe(["--asset", asset, "--expected-digest", digest, "--out", out, "--workdir", workdir]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const record = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(record.schema, PINNED_SCHEMA);
  assert.equal(record.status, "active");
  assert.equal(record.probe.kind, "real_block");
  const argv = JSON.parse(readFileSync(argvPath, "utf8"));
  assert.deepEqual(argv.slice(0, 6), [
    "sandbox",
    "--enforce",
    "--enforce-net",
    "--probe-enforcement",
    "--enforcement-health",
    out,
  ]);
  assert.equal(argv.at(-2), "--");
  assert.equal(argv.at(-1), "true");
  assert.ok(argv.includes("--policy"));
  assert.deepEqual(readFileSync(MATRIX), beforeMatrix);
  rmSync(dir, { recursive: true, force: true });
});

test("public docs pin measured v5.4.0 facts and honest limits", () => {
  const docs = readFileSync(COMPAT_DOC, "utf8");
  const readme = readFileSync(README, "utf8");
  for (const text of [docs, readme]) {
    assert.match(text, /v5\.4\.0/);
    assert.match(text, new RegExp(PINNED_PEEL));
    assert.match(text, new RegExp(PINNED_ASSET_DIGEST.replaceAll(".", "\\.")));
    assert.match(text, /assay\.trust-basis\.diff\.v1/);
    assert.match(text, /schema_version = 5|Trust Card schema v5/);
    assert.match(text, /ten frozen claims|10 frozen claims|10-claim/);
    assert.match(text, /eval.*decision.*inventory/s);
  }
  assert.match(docs, /assay\.enforcement_health\.v1/);
  assert.doesNotMatch(docs, /assay\.enforcement\.health\.v1/);
  assert.match(docs, /no released one-shot|no released one-shot CLI emitter/);
  assert.match(docs, /live-proxy-only/);
  assert.match(docs, /unprivileged/);
  assert.match(docs, /Darwin skip is not a pass|skip is not a pass/);
  assert.match(docs, /not.*universal host support|does not claim universal host support/i);
  assert.doesNotMatch(docs, /requires the released Assay `v3\.8\.0` contract line or later/);
  assert.doesNotMatch(readme, /Current runtime support is deferred to PR2b/);
});

test("committed matrix rows, proofs, generated, and digest stay frozen", () => {
  const raw = readFileSync(MATRIX, "utf8");
  const matrix = JSON.parse(raw);
  assert.equal(matrix.manifest.digest, PINNED_MATRIX_DIGEST);
  assert.equal(matrix.generated.last_verified_assay, "v3.28.0");
  assert.equal(matrix.generated.verified_on, "2026-06-17");
  const enforcement = matrix.carrier_rows.find((row) => row.carrier === PINNED_SCHEMA);
  assert.ok(enforcement);
  assert.equal(enforcement.end_to_end_gap.reason_code, "requires_privileged_runtime");
  assert.match(raw, /"digest": "sha256:ce7640673f9b6f1160e88378aea9f64ef77ae98074fdb067cf21492fcdfd8ea7"/);
});
