#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateTrustCardCompatibility } from "../dist/trust_card_compat.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_BASIS_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

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

function readAndRetainBoundedFile(sourcePath, destPath, maxBytes, label) {
  let st;
  try {
    st = lstatSync(sourcePath);
  } catch (err) {
    fail(`${label} missing or inaccessible: ${sourcePath}`);
  }
  if (st.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link: ${sourcePath}`);
  }
  if (!st.isFile()) {
    fail(`${label} is not a regular file: ${sourcePath}`);
  }
  if (st.size > maxBytes) {
    fail(`${label} size ${st.size} exceeds ceiling ${maxBytes}: ${sourcePath}`);
  }
  const buf = readFileSync(sourcePath);
  if (buf.length > maxBytes) {
    fail(`${label} bytes ${buf.length} exceed ceiling ${maxBytes}: ${sourcePath}`);
  }
  if (sourcePath !== destPath) {
    writeFileSync(destPath, buf);
  }
  const digest = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
  return { bytes: buf.length, digest };
}

function assertRegularFile(filePath, maxBytes, label) {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (err) {
    fail(`${label} missing or inaccessible: ${filePath}`);
  }
  if (st.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link: ${filePath}`);
  }
  if (!st.isFile()) {
    fail(`${label} is not a regular file: ${filePath}`);
  }
  if (st.size > maxBytes) {
    fail(`${label} size ${st.size} exceeds ceiling ${maxBytes}: ${filePath}`);
  }
  return st.size;
}

function hashFile(filePath) {
  const buf = readFileSync(filePath);
  const hash = createHash("sha256").update(buf).digest("hex");
  return `sha256:${hash}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const bundlePath = resolve(args.bundle);
  const basisPath = resolve(args["paired-basis"]);
  const outDir = resolve(args["out-dir"]);
  const assayBin = args["assay-bin"];
  const timeoutMs = args["timeout-ms"];
  const maxOutputBytes = args["max-output-bytes"];

  const cardPath = join(outDir, "trustcard.json");

  // F3: Fresh output identity. Refuse pre-existing trustcard.json in out-dir prior to invocation.
  // Do not delete or overwrite prior run evidence to invent freshness.
  if (existsSync(cardPath)) {
    fail(`pre-existing trustcard.json found in out-dir (${cardPath}); output directory must not contain prior run artifacts`);
  }

  mkdirSync(outDir, { recursive: true });

  const retainedBundle = join(outDir, "bundle.evidence.tar.gz");
  const retainedBasis = join(outDir, "paired.trust-basis.json");

  // F4: Retain bounded input bytes first, hash those exact bytes, and invoke on the retained copy.
  const bundleInfo = readAndRetainBoundedFile(bundlePath, retainedBundle, args["max-bundle-bytes"], "bundle");
  const basisInfo = readAndRetainBoundedFile(basisPath, retainedBasis, MAX_BASIS_BYTES, "paired-basis");

  let basisJson;
  try {
    basisJson = JSON.parse(readFileSync(retainedBasis, "utf8"));
  } catch (err) {
    fail(`failed to parse paired basis JSON: ${err.message}`);
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

  // F4: Verify retained input bytes still match after producer execution before reporting success
  const postBundleBuf = readFileSync(retainedBundle);
  const postBundleDigest = `sha256:${createHash("sha256").update(postBundleBuf).digest("hex")}`;
  if (postBundleDigest !== bundleInfo.digest) {
    fail(`retained bundle mutated during producer execution: pre=${bundleInfo.digest}, post=${postBundleDigest}`);
  }

  const postBasisBuf = readFileSync(retainedBasis);
  const postBasisDigest = `sha256:${createHash("sha256").update(postBasisBuf).digest("hex")}`;
  if (postBasisDigest !== basisInfo.digest) {
    fail(`retained paired basis mutated during producer execution: pre=${basisInfo.digest}, post=${postBasisDigest}`);
  }

  // Verify produced trustcard.json
  const cardBytes = assertRegularFile(cardPath, maxOutputBytes, "trustcard.json");
  const cardDigest = hashFile(cardPath);

  let cardJson;
  try {
    cardJson = JSON.parse(readFileSync(cardPath, "utf8"));
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
      sha256: bundleInfo.digest,
      bytes: bundleInfo.bytes,
    },
    paired_basis: {
      path: retainedBasis,
      sha256: basisInfo.digest,
      bytes: basisInfo.bytes,
    },
    trust_card: {
      path: cardPath,
      sha256: cardDigest,
      bytes: cardBytes,
      schema_version: cardJson?.schema_version,
      claim_count: Array.isArray(cardJson?.claims) ? cardJson.claims.length : 0,
    },
    parity_claim:
      "Parity confirms Trust Card claim levels, sources, boundaries, and notes match paired Trust Basis claims for the same producer invocation on the same bundle (single degree of freedom: claim levels, as source/boundary/note are frozen or hardcoded per claim ID in Assay v6.0.0). It does not authenticate same-bundle origin across arbitrary external bundles.",
    errors: validation.errors,
  };

  const diagnosticPath = join(outDir, "diagnostic.json");
  writeFileSync(diagnosticPath, JSON.stringify(diagnostic, null, 2) + "\n", "utf8");

  if (!validation.valid) {
    const errorDetails = validation.errors.map((e) => `  - [${e.code}] ${e.message}`).join("\n");
    fail(`Trust Card compatibility validation failed:\n${errorDetails}`);
  }

  process.stdout.write(
    `[probe-trust-card-compat] OK: Trust Card schema ${cardJson.schema_version} compatible; claims match paired basis (same-producer consistency).\n`,
  );
}

main();
