#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs, {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateTrustCardCompatibility } from "../dist/trust_card_compat.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_BASIS_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;

const ALLOWED_CLI_OPTIONS = new Set([
  "assay-bin",
  "bundle",
  "paired-basis",
  "out-dir",
  "timeout-ms",
  "max-bundle-bytes",
  "max-output-bytes",
]);

function fail(message, code = 1) {
  process.stderr.write(`[probe-trust-card-compat] ERROR: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const values = {
    "assay-bin": process.env.ASSAY_BIN || "assay",
    "timeout-ms": DEFAULT_TIMEOUT_MS,
    "max-bundle-bytes": MAX_BUNDLE_BYTES,
    "max-output-bytes": MAX_OUTPUT_BYTES,
  };
  const specified = new Set();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--") || token === "--") {
      fail(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (!ALLOWED_CLI_OPTIONS.has(key)) {
      fail(`unknown option: --${key}`);
    }
    if (specified.has(key)) {
      fail(`duplicate option: --${key}`);
    }
    specified.add(key);

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`missing value for --${key}`);
    }
    values[key] = value;
    i += 1;
  }

  if (!values.bundle) fail("--bundle is required");
  if (!values["paired-basis"]) fail("--paired-basis is required");
  if (!values["out-dir"]) fail("--out-dir is required");

  const timeoutRaw = values["timeout-ms"];
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
    fail(`--timeout-ms must be a positive integer <= 3600000; got ${JSON.stringify(timeoutRaw)}`);
  }
  values["timeout-ms"] = timeoutMs;

  const bundleRaw = values["max-bundle-bytes"];
  const maxBundleBytes = Number(bundleRaw);
  if (!Number.isInteger(maxBundleBytes) || maxBundleBytes <= 0 || maxBundleBytes > 1024 * 1024 * 1024) {
    fail(`--max-bundle-bytes must be a positive integer <= 1GB; got ${JSON.stringify(bundleRaw)}`);
  }
  values["max-bundle-bytes"] = maxBundleBytes;

  const outputRaw = values["max-output-bytes"];
  const maxOutputBytes = Number(outputRaw);
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 100 * 1024 * 1024) {
    fail(`--max-output-bytes must be a positive integer <= 100MB; got ${JSON.stringify(outputRaw)}`);
  }
  values["max-output-bytes"] = maxOutputBytes;

  return values;
}

/**
 * Open no-follow where supported, fstat the open descriptor before materialization,
 * read at most maxBytes + 1 under the actual descriptor, reject oversized or non-regular
 * sources, and close reliably.
 */
export function readBoundedRegularFile(filePath, maxBytes, label, fsImpl = fs) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = fsImpl.openSync(filePath, flags);
  } catch (err) {
    if (err.code === "ELOOP" || err.code === "SYMLINK_LOOP") {
      throw new Error(`${label} must not be a symbolic link: ${filePath}`);
    }
    throw new Error(`${label} missing or inaccessible: ${filePath}`);
  }

  try {
    let st;
    try {
      st = fsImpl.fstatSync(fd);
    } catch (err) {
      throw new Error(`failed to stat ${label}: ${err.message}`);
    }

    if (!st.isFile()) {
      throw new Error(`${label} is not a regular file: ${filePath}`);
    }
    if (st.size > maxBytes) {
      throw new Error(`${label} size ${st.size} exceeds ceiling ${maxBytes}: ${filePath}`);
    }

    const chunks = [];
    let total = 0;
    const toReadLimit = maxBytes + 1;

    while (total < toReadLimit) {
      const chunkSize = Math.min(READ_CHUNK, toReadLimit - total);
      const buf = Buffer.alloc(chunkSize);
      const n = fsImpl.readSync(fd, buf, 0, chunkSize, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) {
        throw new Error(`${label} size ${total} exceeds ceiling ${maxBytes}: ${filePath}`);
      }
      chunks.push(buf.subarray(0, n));
    }

    return Buffer.concat(chunks);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function run() {
  const args = parseArgs(process.argv.slice(2));

  const bundlePath = resolve(args.bundle);
  const basisPath = resolve(args["paired-basis"]);
  const outDir = resolve(args["out-dir"]);
  const assayBin = args["assay-bin"];
  const timeoutMs = args["timeout-ms"];
  const maxOutputBytes = args["max-output-bytes"];

  const cardPath = join(outDir, "trustcard.json");
  const retainedBundle = join(outDir, "bundle.evidence.tar.gz");
  const retainedBasis = join(outDir, "paired.trust-basis.json");
  const diagnosticPath = join(outDir, "diagnostic.json");

  // F3: Fresh output identity. Refuse any pre-existing run artifacts in out-dir prior to writing or spawn.
  // Do not delete or overwrite prior run evidence to manufacture freshness.
  if (existsSync(cardPath)) {
    fail(
      `pre-existing trustcard.json found in out-dir (${cardPath}); output directory must not contain prior run artifacts`,
    );
  }
  const existingArtifacts = [retainedBundle, retainedBasis, diagnosticPath].filter((p) => existsSync(p));
  if (existingArtifacts.length > 0) {
    fail(
      `pre-existing run artifacts found in out-dir (${existingArtifacts.join(", ")}); output directory must not contain prior run artifacts`,
    );
  }

  // F4: Read bounded input bytes first under strict ceilings
  const bundleBuf = readBoundedRegularFile(bundlePath, args["max-bundle-bytes"], "bundle");
  const bundleDigest = `sha256:${createHash("sha256").update(bundleBuf).digest("hex")}`;

  const basisBuf = readBoundedRegularFile(basisPath, MAX_BASIS_BYTES, "paired-basis");
  const basisDigest = `sha256:${createHash("sha256").update(basisBuf).digest("hex")}`;

  let basisJson;
  try {
    basisJson = JSON.parse(basisBuf.toString("utf8"));
  } catch (err) {
    fail(`failed to parse paired basis JSON: ${err.message}`);
  }

  mkdirSync(outDir, { recursive: true });

  // Use exclusive creation for retained outputs to guarantee at OS syscall level that prior files cannot be overwritten
  try {
    writeFileSync(retainedBundle, bundleBuf, { flag: "wx" });
  } catch (err) {
    fail(`failed to exclusively retain bundle at ${retainedBundle}: ${err.message}`);
  }
  try {
    writeFileSync(retainedBasis, basisBuf, { flag: "wx" });
  } catch (err) {
    fail(`failed to exclusively retain paired basis at ${retainedBasis}: ${err.message}`);
  }

  // Execute producer command on the retained copy
  const spawnResult = spawnSync(
    assayBin,
    ["trust-card", "generate", retainedBundle, "--out-dir", outDir],
    {
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      encoding: "utf8",
    },
  );

  if (spawnResult.error) {
    fail(`failed to spawn assay-bin (${assayBin}): ${spawnResult.error.message}`);
  }

  if (spawnResult.signal === "SIGTERM" || spawnResult.status === null) {
    fail(`producer timed out after ${timeoutMs}ms`);
  }

  if (spawnResult.status !== 0) {
    fail(
      `producer exited with code ${spawnResult.status}: ${spawnResult.stderr || spawnResult.stdout}`,
    );
  }

  // F4: Verify retained input bytes still match after producer execution under bounded reads
  const postBundleBuf = readBoundedRegularFile(retainedBundle, args["max-bundle-bytes"], "retained bundle");
  const postBundleDigest = `sha256:${createHash("sha256").update(postBundleBuf).digest("hex")}`;
  if (postBundleDigest !== bundleDigest) {
    fail(`retained bundle mutated during producer execution: pre=${bundleDigest}, post=${postBundleDigest}`);
  }

  const postBasisBuf = readBoundedRegularFile(retainedBasis, MAX_BASIS_BYTES, "retained paired basis");
  const postBasisDigest = `sha256:${createHash("sha256").update(postBasisBuf).digest("hex")}`;
  if (postBasisDigest !== basisDigest) {
    fail(`retained paired basis mutated during producer execution: pre=${basisDigest}, post=${postBasisDigest}`);
  }

  // F4: Verify produced trustcard.json using the shared bounded reader (same bytes for digest and parse)
  const cardBuf = readBoundedRegularFile(cardPath, maxOutputBytes, "trustcard.json");
  const cardDigest = `sha256:${createHash("sha256").update(cardBuf).digest("hex")}`;

  let cardJson;
  try {
    cardJson = JSON.parse(cardBuf.toString("utf8"));
  } catch (err) {
    fail(`produced trustcard.json is not valid JSON: ${err.message}`);
  }

  // Run pure structural and parity validation
  const validation = validateTrustCardCompatibility(cardJson, basisJson);

  const diagnostic = {
    schema: "assay.trust_card_compat_diagnostic.v1",
    timestamp: new Date().toISOString(),
    valid: validation.valid,
    claims_parity: validation.claimsParity,
    bundle: {
      path: retainedBundle,
      sha256: bundleDigest,
      bytes: bundleBuf.length,
    },
    paired_basis: {
      path: retainedBasis,
      sha256: basisDigest,
      bytes: basisBuf.length,
    },
    trust_card: {
      path: cardPath,
      sha256: cardDigest,
      bytes: cardBuf.length,
      schema_version: cardJson?.schema_version,
      claim_count: Array.isArray(cardJson?.claims) ? cardJson.claims.length : 0,
    },
    parity_claim:
      "Parity confirms Trust Card claim levels, sources, boundaries, and notes match paired Trust Basis claims for the same producer invocation on the same bundle (single degree of freedom: claim levels, as source/boundary/note are frozen or hardcoded per claim ID in Assay v6.0.0). It does not authenticate same-bundle origin across arbitrary external bundles.",
    errors: validation.errors,
  };

  try {
    writeFileSync(diagnosticPath, JSON.stringify(diagnostic, null, 2) + "\n", { flag: "wx" });
  } catch (err) {
    fail(`failed to write diagnostic (${diagnosticPath}): ${err.message}`);
  }

  if (!validation.valid) {
    const errorDetails = validation.errors.map((e) => `  - [${e.code}] ${e.message}`).join("\n");
    fail(`Trust Card compatibility validation failed:\n${errorDetails}`);
  }

  process.stdout.write(
    `[probe-trust-card-compat] OK: Trust Card schema ${cardJson.schema_version} compatible; claims match paired basis (same-producer consistency).\n`,
  );
}

function main() {
  try {
    run();
  } catch (err) {
    fail(err.message);
  }
}

if (
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1]))
) {
  main();
}
