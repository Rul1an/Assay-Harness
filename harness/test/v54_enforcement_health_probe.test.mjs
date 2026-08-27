import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MAX_ASSET_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  MEASURED_SCHEMA,
  PUBLISHED_LINUX_CLI_DIGEST,
  V54_PEEL,
  executeLocalProducer,
  parseExactlyOneJson,
  requireMeasuredActiveClaim,
  snapshotAssetWhileHashing,
} from "../scripts/probe-v54-enforcement-health.mjs";

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
const PEEL_CLAIM = `${PINNED_SCHEMA} active at peel ${PINNED_PEEL}`;
const FIXED_ALLOWED_PORT = 443;

const ACTIVE_HEALTH = {
  schema: PINNED_SCHEMA,
  status: "active",
  mechanism: "landlock",
  scope: "tcp_connect_landlock_port",
  policy_semantics: "allowlist",
  enforcement_class: "strong",
  landlock: {
    abi: 4,
    handled_access_net: ["connect_tcp"],
    allowed_connect_tcp_ports: [FIXED_ALLOWED_PORT],
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
};

function sha256File(path) {
  return "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "v54-probe-fixture-"));
}

function ownedProbeTemps() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("v54-enforcement-health-"))
    .map((name) => join(tmpdir(), name));
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

function fakeAssay({ health, exit = 0, sleepMs = 0, argvPath, extraBytes = 0, write = true } = {}) {
  const payload = typeof health === "string" ? health : JSON.stringify(health ?? ACTIVE_HEALTH);
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const i = args.indexOf("--enforcement-health");
const out = i >= 0 ? args[i + 1] : null;
${argvPath ? `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args));` : ""}
${sleepMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${sleepMs});` : ""}
if (out && ${write}) {
  let body = ${JSON.stringify(payload)};
  ${extraBytes ? `body += "x".repeat(${extraBytes});` : ""}
  fs.writeFileSync(out, body);
}
process.exit(${exit});
`;
}

function runProbe(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function stageGreen(dir, extras = {}) {
  const argvPath = join(dir, "argv.json");
  const packed = packAsset(dir, { assaySource: fakeAssay({ argvPath, ...extras }) });
  const out = join(dir, "enforcement-health.json");
  const workdir = join(dir, "work");
  mkdirSync(workdir);
  return { ...packed, out, workdir, argvPath };
}

function localArgs(staged) {
  return ["--asset", staged.asset, "--expected-digest", staged.digest, "--out", staged.out];
}

test("exported pins match the published v5.4 identity", () => {
  assert.equal(MEASURED_SCHEMA, PINNED_SCHEMA);
  assert.equal(PUBLISHED_LINUX_CLI_DIGEST, PINNED_ASSET_DIGEST);
  assert.equal(V54_PEEL, PINNED_PEEL);
});

test("caller --workdir is rejected; workdir is a private mkdtemp", () => {
  const dir = tempDir();
  const staged = stageGreen(dir);
  const r = runProbe([
    "--asset", staged.asset,
    "--expected-digest", PINNED_ASSET_DIGEST,
    "--out", staged.out,
    "--workdir", staged.workdir,
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /workdir/i);
  assert.equal(existsSync(join(staged.workdir, LAYOUT)), false);
});

test("requested ceilings and timeout cannot be raised above fixed maxima", () => {
  const dir = tempDir();
  const staged = stageGreen(dir);
  for (const [flag, value] of [
    ["--max-asset-bytes", String(MAX_ASSET_BYTES + 1)],
    ["--max-output-bytes", String(MAX_OUTPUT_BYTES + 1)],
    ["--timeout-ms", String(MAX_TIMEOUT_MS + 1)],
  ]) {
    const r = runProbe([
      "--asset", staged.asset,
      "--expected-digest", PINNED_ASSET_DIGEST,
      "--out", staged.out,
      flag, value,
    ]);
    assert.notEqual(r.status, 0, `${flag}: ${r.stderr}`);
    assert.match(r.stderr, /ceiling|raise|maximum|maxima/i);
  }
});

test("wrong digest fails closed before extraction", () => {
  const dir = tempDir();
  const { asset, out, workdir } = stageGreen(dir);
  const r = runProbe(["--asset", asset, "--expected-digest", PINNED_ASSET_DIGEST, "--out", out]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /digest|sha256|published/i);
  assert.equal(existsSync(join(workdir, LAYOUT)), false);
  assert.doesNotMatch(r.stdout, new RegExp(PEEL_CLAIM.replaceAll(".", "\\.")));
});

test("missing asset fails closed without a network fallback", () => {
  const dir = tempDir();
  const r = runProbe([
    "--asset", join(dir, `${LAYOUT}.tar.gz`),
    "--expected-digest", PINNED_ASSET_DIGEST,
    "--out", join(dir, "health.json"),
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /missing|not found|ENOENT/i);
  assert.doesNotMatch(r.stderr, /download|github\.com\/Rul1an\/assay\/releases|curl|wget/i);
});

test("CLI pin refuses a fake tarball and does not print the peel claim", () => {
  const dir = tempDir();
  const staged = stageGreen(dir);
  assert.notEqual(staged.digest, PINNED_ASSET_DIGEST);
  const r = runProbe(localArgs(staged));
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /published|expected-digest|digest/i);
  assert.doesNotMatch(r.stdout, new RegExp(PEEL_CLAIM.replaceAll(".", "\\.")));
  assert.doesNotMatch(r.stdout, /active at peel/);
});

test("mutating the expected-digest pin to true still cannot print a peel claim for a fake tar", () => {
  const dir = tempDir();
  const staged = stageGreen(dir);
  const source = readFileSync(SCRIPT, "utf8");
  const needle = "declared !== PUBLISHED_LINUX_CLI_DIGEST";
  assert.ok(source.includes(needle), "shared digest check must pin the declared digest");
  const mutated = join(dir, "mutated-probe.mjs");
  writeFileSync(mutated, source.replace(needle, "false"));
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { pathToFileURL } from "node:url";
       const mod = await import(pathToFileURL(process.argv[1]).href);
       mod.runV54EnforcementHealthProbe(process.argv.slice(2));`,
      mutated,
      ...localArgs(staged),
    ],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(r.stdout, /active at peel/);
  assert.notEqual(r.status, 0, "a fake tar must not become a v5.4 peel claim after pin mutation");
  assert.match(r.stderr, /published|digest/i);
});

test("pre-existing --out is refused before spawn", () => {
  const dir = tempDir();
  const staged = stageGreen(dir, { write: false });
  writeFileSync(staged.out, JSON.stringify(ACTIVE_HEALTH));
  const r = runProbe([
    "--asset", staged.asset,
    "--expected-digest", PINNED_ASSET_DIGEST,
    "--out", staged.out,
  ]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /pre-existing|already exists|refuse/i);
  assert.deepEqual(JSON.parse(readFileSync(staged.out, "utf8")), ACTIVE_HEALTH);
  assert.doesNotMatch(r.stdout, /active at peel/);
});

test("source asset replacement after snapshot does not change the hashed private copy", () => {
  const dir = tempDir();
  const staged = stageGreen(dir);
  const snapshot = join(dir, "snapshot.tar.gz");
  const digest = snapshotAssetWhileHashing(staged.asset, snapshot, MAX_ASSET_BYTES);
  assert.equal(digest, staged.digest);
  writeFileSync(staged.asset, "replaced-after-snapshot");
  assert.equal(sha256File(snapshot), digest);
  assert.notEqual(sha256File(staged.asset), digest);
});

test("production extract path: missing binary, malformed output, timeout, nonzero exit, caps", () => {
  const dir = tempDir();
  const empty = packAsset(dir);
  assert.throws(() => executeLocalProducer({ asset: empty.asset, out: join(dir, "a.json") }), /binary|assay/i);

  const malformed = stageGreen(dir, { health: "{not-json" });
  assert.throws(() => executeLocalProducer(malformed), /malformed|JSON|parse/i);

  const extra = stageGreen(tempDir(), { extraBytes: 80 });
  assert.throws(() => executeLocalProducer({ ...extra, maxOutputBytes: 32 }), /cap|too large|max-output/i);

  const timed = stageGreen(tempDir(), { sleepMs: 2000 });
  assert.throws(() => executeLocalProducer({ ...timed, timeoutMs: 150 }), /timeout/i);

  const nonzero = stageGreen(tempDir(), { exit: 7 });
  assert.throws(() => executeLocalProducer(nonzero), /exit|nonzero|status/i);
});

test("parseExactlyOneJson rejects extra records and the dotted schema is not a clean claim", () => {
  assert.throws(() => parseExactlyOneJson(`${JSON.stringify(ACTIVE_HEALTH)}\n${JSON.stringify(ACTIVE_HEALTH)}\n`), /exactly one|extra|surplus|trailing/i);
  assert.throws(() => requireMeasuredActiveClaim({ ...ACTIVE_HEALTH, schema: DOTTED_SCHEMA }), /schema/i);
});

test("status=failed is truthful but not a clean Landlock result", () => {
  assert.throws(
    () => requireMeasuredActiveClaim({
      ...ACTIVE_HEALTH,
      status: "failed",
      probe: null,
      failure: { reason_code: "landlock_unavailable", detail: "host" },
    }),
    /failed|not clean|unavailable|active/i,
  );
});

test("probe=null and listener_reached=true cannot support the printed active claim", () => {
  assert.throws(() => requireMeasuredActiveClaim({ ...ACTIVE_HEALTH, probe: null }), /probe/i);
  assert.throws(
    () => requireMeasuredActiveClaim({
      ...ACTIVE_HEALTH,
      probe: { ...ACTIVE_HEALTH.probe, listener_reached: true },
    }),
    /listener_reached/i,
  );
});

test("missing or non-canonical allowed_connect_tcp_ports fails closed", () => {
  const omitted = structuredClone(ACTIVE_HEALTH);
  delete omitted.landlock.allowed_connect_tcp_ports;
  assert.throws(() => requireMeasuredActiveClaim(omitted), /allowed_connect_tcp_ports/i);
  assert.throws(
    () => requireMeasuredActiveClaim({
      ...ACTIVE_HEALTH,
      landlock: { ...ACTIVE_HEALTH.landlock, allowed_connect_tcp_ports: [443, 80] },
    }),
    /allowed_connect_tcp_ports/i,
  );
});

test("success and failing producer leave no owned v54-enforcement-health temp dirs", () => {
  const before = new Set(ownedProbeTemps());
  const success = stageGreen(tempDir());
  executeLocalProducer(success);
  assert.ok(existsSync(success.out), "caller --out must be preserved");
  const leftoverSuccess = ownedProbeTemps().filter((path) => !before.has(path));
  assert.deepEqual(leftoverSuccess, [], leftoverSuccess.join(" "));

  const failing = stageGreen(tempDir(), { exit: 7 });
  assert.throws(() => executeLocalProducer(failing), /exit|nonzero|status/i);
  const leftoverFail = ownedProbeTemps().filter((path) => !before.has(path));
  assert.deepEqual(leftoverFail, [], leftoverFail.join(" "));
});

test("near-miss: flipping enforcement_class or a confirmation boolean fails the active claim", () => {
  assert.throws(
    () => requireMeasuredActiveClaim({ ...ACTIVE_HEALTH, enforcement_class: "standard" }),
    /enforcement_class/i,
  );
  assert.throws(
    () => requireMeasuredActiveClaim({
      ...ACTIVE_HEALTH,
      landlock: { ...ACTIVE_HEALTH.landlock, no_new_privs_confirmed: false },
    }),
    /no_new_privs_confirmed/i,
  );
});

test("no-op control: measured successful shape is accepted by the shared validator", () => {
  assert.doesNotThrow(() => requireMeasuredActiveClaim(ACTIVE_HEALTH));
  const before = readFileSync(MATRIX);
  const dir = tempDir();
  const staged = stageGreen(dir);
  const argv = executeLocalProducer(staged);
  assert.deepEqual(argv.slice(0, 6), [
    "sandbox", "--enforce", "--enforce-net", "--probe-enforcement", "--enforcement-health", staged.out,
  ]);
  assert.equal(argv.at(-2), "--");
  assert.equal(argv.at(-1), "true");
  assert.ok(argv.includes("--policy"));
  assert.deepEqual(readFileSync(MATRIX), before);
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
  const enforcement = matrix.carrier_rows.find((row) => row.carrier === PINNED_SCHEMA);
  assert.ok(enforcement);
  assert.equal(enforcement.end_to_end_gap.reason_code, "requires_privileged_runtime");
  assert.match(raw, /"digest": "sha256:ce7640673f9b6f1160e88378aea9f64ef77ae98074fdb067cf21492fcdfd8ea7"/);
});
