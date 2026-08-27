#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MEASURED_SCHEMA = "assay.enforcement_health.v1";
export const V54_PEEL = "bbb5e7fe4b03bc6160d18e2966e75a7586c062ef";
export const PUBLISHED_LINUX_CLI_DIGEST =
  "sha256:352cd390dc59fb5adacecae5adf51976419f18ae50918f8f1504952869e94ad3";
export const RELEASE_LAYOUT = "assay-v5.4.0-x86_64-unknown-linux-gnu";

const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const FORBIDDEN_NET_FLAGS = new Set(["download", "url", "from-release", "fetch"]);

const DEFAULT_POLICY = `api_version: "assay/v1"
fs:
  allow: []
  deny: []
net:
  allow:
    - "443"
  deny: []
`;

function fail(message, code = 3) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const values = {
    "timeout-ms": DEFAULT_TIMEOUT_MS,
    "max-asset-bytes": DEFAULT_MAX_ASSET_BYTES,
    "max-output-bytes": DEFAULT_MAX_OUTPUT_BYTES,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--") || token === "--") {
      fail(`unknown argument: ${token}`, 2);
    }
    const key = token.slice(2);
    if (FORBIDDEN_NET_FLAGS.has(key)) {
      fail("network fallback is refused; pass a local --asset", 2);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`missing value for --${key}`, 2);
    }
    values[key] = value;
    i += 1;
  }
  const allowed = new Set([
    "asset",
    "expected-digest",
    "out",
    "workdir",
    "policy",
    "timeout-ms",
    "max-asset-bytes",
    "max-output-bytes",
  ]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) fail(`unknown flag --${key}`, 2);
  }
  if (!values.asset || !values["expected-digest"] || !values.out) {
    fail("usage: --asset <tarball> --expected-digest sha256:<hex> --out <json>", 2);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(values["expected-digest"])) {
    fail("expected-digest must be sha256:<64 lowercase hex>", 2);
  }
  values["timeout-ms"] = Number(values["timeout-ms"]);
  values["max-asset-bytes"] = Number(values["max-asset-bytes"]);
  values["max-output-bytes"] = Number(values["max-output-bytes"]);
  if (![values["timeout-ms"], values["max-asset-bytes"], values["max-output-bytes"]].every((n) => Number.isInteger(n) && n > 0)) {
    fail("timeout-ms, max-asset-bytes, and max-output-bytes must be positive integers", 2);
  }
  return values;
}

function hashAssetBeforeExtract(assetPath, maxBytes) {
  let st;
  try {
    st = statSync(assetPath);
  } catch {
    fail(`asset missing: ${assetPath}`, 2);
  }
  if (!st.isFile()) fail(`asset missing: not a file: ${assetPath}`, 2);
  if (st.size > maxBytes) fail(`asset too large for max-asset-bytes=${maxBytes}`, 3);
  const hash = createHash("sha256");
  const fd = openSync(assetPath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) fail(`asset too large for max-asset-bytes=${maxBytes}`, 3);
      hash.update(buf.subarray(0, n));
    }
    if (total !== st.size) fail("asset size changed during bounded read", 3);
  } finally {
    closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

function assertSafeTarEntries(assetPath) {
  const listed = spawnSync("tar", ["-tzf", assetPath], { encoding: "utf8" });
  if (listed.status !== 0) fail(`unable to list asset: ${listed.stderr || listed.stdout}`, 3);
  for (const name of listed.stdout.split("\n").filter(Boolean)) {
    if (name.startsWith("/") || name.split("/").includes("..")) {
      fail(`unsafe tar entry: ${name}`, 3);
    }
  }
}

function extractAfterDigest(assetPath, workdir) {
  mkdirSync(workdir, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", assetPath, "-C", workdir], { encoding: "utf8" });
  if (extracted.status !== 0) fail(`extract failed: ${extracted.stderr || extracted.stdout}`, 3);
}

function parseExactlyOneJson(text) {
  const start = text.search(/\S/);
  if (start < 0) throw new Error("malformed JSON: empty");
  let depth = 0;
  let inStr = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") {
      inStr = true;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    } else if (c === "[" && depth === 0) {
      throw new Error("malformed JSON: expected exactly one object");
    }
  }
  if (end < 0 || depth !== 0) throw new Error("malformed JSON");
  if (/\S/.test(text.slice(end + 1))) {
    throw new Error("exactly one JSON record required; extra trailing data");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function requireTruthfulHealth(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    fail("malformed JSON: health record must be one object", 3);
  }
  if (record.schema !== MEASURED_SCHEMA) {
    fail(`schema mismatch: expected ${MEASURED_SCHEMA}`, 3);
  }
  if (record.status !== "active" && record.status !== "failed") {
    fail("status must be active or failed", 3);
  }
  if (!Object.hasOwn(record, "probe")) fail("probe key missing", 3);
  if (record.probe !== null) {
    if (typeof record.probe !== "object") fail("probe shape invalid", 3);
    for (const key of ["kind", "transport", "blocked_action", "blocked_port", "blocked_errno", "listener_reached"]) {
      if (!Object.hasOwn(record.probe, key)) fail(`probe shape invalid: missing ${key}`, 3);
    }
  }
  if (record.status !== "active") {
    fail("status=failed is not a clean Landlock result (unavailable or unenforced)", 3);
  }
}

export function runV54EnforcementHealthProbe(argv) {
  const args = parseArgs(argv);
  const digest = hashAssetBeforeExtract(args.asset, args["max-asset-bytes"]);
  if (digest !== args["expected-digest"]) {
    fail(`asset digest mismatch: got ${digest} expected ${args["expected-digest"]}`, 3);
  }
  assertSafeTarEntries(args.asset);
  const workdir = args.workdir ?? join(tmpdir(), `v54-enforcement-health-${process.pid}`);
  extractAfterDigest(args.asset, workdir);
  const bin = join(workdir, RELEASE_LAYOUT, "assay");
  if (!existsSync(bin) || !statSync(bin).isFile()) {
    fail(`assay binary missing at ${RELEASE_LAYOUT}/assay`, 3);
  }
  const policyPath = args.policy ?? join(workdir, "probe-policy.yaml");
  if (!args.policy) writeFileSync(policyPath, DEFAULT_POLICY);
  const child = spawnSync(
    bin,
    [
      "sandbox",
      "--enforce",
      "--enforce-net",
      "--probe-enforcement",
      "--enforcement-health",
      args.out,
      "--policy",
      policyPath,
      "--",
      "true",
    ],
    {
      encoding: "utf8",
      timeout: args["timeout-ms"],
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.error?.code === "ETIMEDOUT" || child.signal === "SIGKILL") {
    fail("producer timeout", 3);
  }
  if (child.status !== 0) {
    fail(`producer exit nonzero: ${child.status ?? child.error?.message ?? "unknown"}`, 3);
  }
  let outStat;
  try {
    outStat = statSync(args.out);
  } catch {
    fail("producer output missing", 3);
  }
  if (outStat.size > args["max-output-bytes"]) {
    fail(`producer output too large for max-output-bytes=${args["max-output-bytes"]}`, 3);
  }
  const text = openAndReadBounded(args.out, args["max-output-bytes"]);
  let record;
  try {
    record = parseExactlyOneJson(text);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 3);
  }
  requireTruthfulHealth(record);
  process.stdout.write(`${MEASURED_SCHEMA} active at peel ${V54_PEEL}\n`);
}

function openAndReadBounded(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > maxBytes) fail(`producer output too large for max-output-bytes=${maxBytes}`, 3);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runV54EnforcementHealthProbe(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 3);
  }
}
