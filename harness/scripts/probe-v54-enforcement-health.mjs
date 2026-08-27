#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MEASURED_SCHEMA = "assay.enforcement_health.v1";
export const V54_PEEL = "bbb5e7fe4b03bc6160d18e2966e75a7586c062ef";
export const PUBLISHED_LINUX_CLI_DIGEST =
  "sha256:352cd390dc59fb5adacecae5adf51976419f18ae50918f8f1504952869e94ad3";
export const RELEASE_LAYOUT = "assay-v5.4.0-x86_64-unknown-linux-gnu";
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_TIMEOUT_MS = 30_000;
// Same measured published layout / ceilings as v54-tar-entry-bounds.mjs.
export const MEASURED_PUBLISHED_ISIZE_SUM = 31_683_222;
export const MEASURED_PUBLISHED_ENTRY_COUNT = 4;
export const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
export const MAX_TAR_ENTRIES = 8;
export const FIXED_ALLOWED_PORT = 443;
export const FIXED_ALLOWED_CONNECT_TCP_PORTS = Object.freeze([FIXED_ALLOWED_PORT]);

const READ_CHUNK = 64 * 1024;
const TAR_BOUNDS = fileURLToPath(new URL("./v54-tar-entry-bounds.mjs", import.meta.url));
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

function withOwnedTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), `v54-enforcement-health-${process.pid}-`));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function requirePublishedDigests(declared, actual) {
  if (declared !== PUBLISHED_LINUX_CLI_DIGEST) {
    throw new Error("expected-digest is not the published v5.4 Linux CLI digest");
  }
  if (actual !== PUBLISHED_LINUX_CLI_DIGEST) {
    throw new Error(`asset digest is not the published v5.4 Linux CLI digest: got ${actual}`);
  }
}

function boundCeiling(name, value, maximum) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (value > maximum) {
    throw new Error(`${name} cannot raise the fixed maximum ceiling`);
  }
  return value;
}

export function parseCliArgs(argv) {
  const values = {
    "timeout-ms": MAX_TIMEOUT_MS,
    "max-asset-bytes": MAX_ASSET_BYTES,
    "max-output-bytes": MAX_OUTPUT_BYTES,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--") || token === "--") {
      throw new Error(`unknown argument: ${token}`);
    }
    const key = token.slice(2);
    if (key === "workdir") {
      throw new Error("caller --workdir is rejected; workdir is a private mkdtemp");
    }
    if (FORBIDDEN_NET_FLAGS.has(key)) {
      throw new Error("network fallback is refused; pass a local --asset");
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    values[key] = value;
    i += 1;
  }
  const allowed = new Set(["asset", "expected-digest", "out", "policy", "timeout-ms", "max-asset-bytes", "max-output-bytes"]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
  }
  if (!values.asset || !values["expected-digest"] || !values.out) {
    throw new Error("usage: --asset <tarball> --expected-digest sha256:<hex> --out <json>");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(values["expected-digest"])) {
    throw new Error("expected-digest must be sha256:<64 lowercase hex>");
  }
  values["timeout-ms"] = boundCeiling("timeout-ms", Number(values["timeout-ms"]), MAX_TIMEOUT_MS);
  values["max-asset-bytes"] = boundCeiling("max-asset-bytes", Number(values["max-asset-bytes"]), MAX_ASSET_BYTES);
  values["max-output-bytes"] = boundCeiling("max-output-bytes", Number(values["max-output-bytes"]), MAX_OUTPUT_BYTES);
  return values;
}

export function snapshotAssetWhileHashing(srcPath, destPath, maxBytes) {
  let st;
  try {
    st = statSync(srcPath);
  } catch {
    throw new Error(`asset missing: ${srcPath}`);
  }
  if (!st.isFile()) throw new Error(`asset missing: not a file: ${srcPath}`);
  if (st.size > maxBytes) throw new Error(`asset too large for max-asset-bytes=${maxBytes}`);
  const hash = createHash("sha256");
  const src = openSync(srcPath, "r");
  const dest = openSync(destPath, "w");
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    let total = 0;
    for (;;) {
      const n = readSync(src, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error(`asset too large for max-asset-bytes=${maxBytes}`);
      writeSync(dest, buf, 0, n);
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(src);
    closeSync(dest);
  }
  return `sha256:${hash.digest("hex")}`;
}

function assertSafeTarEntries(assetPath, timeoutMs = MAX_TIMEOUT_MS) {
  const boundedTimeout = boundCeiling("timeout-ms", timeoutMs, MAX_TIMEOUT_MS);
  const listed = spawnSync(process.execPath, [TAR_BOUNDS, assetPath, String(boundedTimeout)], {
    encoding: "utf8",
    timeout: boundedTimeout,
    killSignal: "SIGKILL",
  });
  if (listed.error?.code === "ETIMEDOUT" || listed.signal === "SIGKILL") {
    throw new Error("listing timeout");
  }
  if (listed.status !== 0) {
    throw new Error((listed.stderr || listed.stdout || "unable to list asset").trim());
  }
}

export function parseExactlyOneJson(text) {
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

function requireField(record, key, expected) {
  if (record[key] !== expected) {
    throw new Error(`${key} must be ${expected}`);
  }
}

export function requireMeasuredActiveClaim(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("malformed JSON: health record must be one object");
  }
  requireField(record, "schema", MEASURED_SCHEMA);
  if (record.status !== "active") {
    throw new Error("status=failed is not a clean Landlock result (unavailable or unenforced)");
  }
  requireField(record, "mechanism", "landlock");
  requireField(record, "scope", "tcp_connect_landlock_port");
  requireField(record, "policy_semantics", "allowlist");
  requireField(record, "enforcement_class", "strong");
  const landlock = record.landlock;
  if (landlock === null || typeof landlock !== "object") {
    throw new Error("landlock block missing");
  }
  if (!Number.isInteger(landlock.abi) || landlock.abi < 4) {
    throw new Error("landlock.abi must be >= 4");
  }
  if (!Array.isArray(landlock.handled_access_net) || !landlock.handled_access_net.includes("connect_tcp")) {
    throw new Error("handled_access_net must contain connect_tcp");
  }
  if (landlock.no_new_privs_confirmed !== true) {
    throw new Error("no_new_privs_confirmed must be true");
  }
  if (landlock.restrict_self_confirmed !== true) {
    throw new Error("restrict_self_confirmed must be true");
  }
  const probe = record.probe;
  if (probe === null || typeof probe !== "object") {
    throw new Error("probe must be a real_block object");
  }
  requireField(probe, "kind", "real_block");
  requireField(probe, "transport", "ipv4");
  requireField(probe, "blocked_action", "tcp_connect");
  requireField(probe, "blocked_errno", "EACCES");
  if (probe.listener_reached !== false) {
    throw new Error("listener_reached must be false");
  }
  const allowed = landlock.allowed_connect_tcp_ports;
  if (
    !Array.isArray(allowed) ||
    allowed.length !== FIXED_ALLOWED_CONNECT_TCP_PORTS.length ||
    allowed.some((port, i) => port !== FIXED_ALLOWED_CONNECT_TCP_PORTS[i])
  ) {
    throw new Error("allowed_connect_tcp_ports must equal the fixed policy [443]");
  }
  const port = probe.blocked_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || allowed.includes(port)) {
    throw new Error("blocked_port must be a denied TCP port outside the fixed allowlist");
  }
}

function readBounded(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    const chunks = [];
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, total);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error(`producer output too large for max-output-bytes=${maxBytes}`);
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function executeLocalProducer({
  asset,
  out,
  policy,
  timeoutMs = MAX_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
}) {
  return withOwnedTemp((workdir) => {
    assertSafeTarEntries(asset, timeoutMs);
    const extracted = spawnSync("tar", ["-xzf", asset, "-C", workdir], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    if (extracted.error?.code === "ETIMEDOUT" || extracted.signal === "SIGKILL") {
      throw new Error("extract timeout");
    }
    if (extracted.status !== 0) throw new Error(`extract failed: ${extracted.stderr || extracted.stdout}`);
    const bin = join(workdir, RELEASE_LAYOUT, "assay");
    if (!existsSync(bin) || !statSync(bin).isFile()) {
      throw new Error(`assay binary missing at ${RELEASE_LAYOUT}/assay`);
    }
    const policyPath = policy ?? join(workdir, "probe-policy.yaml");
    if (!policy) writeFileSync(policyPath, DEFAULT_POLICY);
    const argv = [
      "sandbox",
      "--enforce",
      "--enforce-net",
      "--probe-enforcement",
      "--enforcement-health",
      out,
      "--policy",
      policyPath,
      "--",
      "true",
    ];
    const child = spawnSync(bin, argv, {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: READ_CHUNK,
    });
    if (child.error?.code === "ETIMEDOUT" || child.signal === "SIGKILL") {
      throw new Error("producer timeout");
    }
    if (child.status !== 0) {
      throw new Error(`producer exit nonzero: ${child.status ?? child.error?.message ?? "unknown"}`);
    }
    if (!existsSync(out)) throw new Error("producer output missing");
    const record = parseExactlyOneJson(readBounded(out, maxOutputBytes));
    requireMeasuredActiveClaim(record);
    return argv;
  });
}

export function runV54EnforcementHealthProbe(argv) {
  const args = parseCliArgs(argv);
  if (existsSync(args.out)) {
    throw new Error("refusing pre-existing --out");
  }
  return withOwnedTemp((workdir) => {
    const snapshot = join(workdir, "asset.tar.gz");
    const actual = snapshotAssetWhileHashing(args.asset, snapshot, args["max-asset-bytes"]);
    requirePublishedDigests(args["expected-digest"], actual);
    executeLocalProducer({
      asset: snapshot,
      out: args.out,
      policy: args.policy,
      timeoutMs: args["timeout-ms"],
      maxOutputBytes: args["max-output-bytes"],
    });
    process.stdout.write(`${MEASURED_SCHEMA} active at peel ${V54_PEEL}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runV54EnforcementHealthProbe(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 3);
  }
}
