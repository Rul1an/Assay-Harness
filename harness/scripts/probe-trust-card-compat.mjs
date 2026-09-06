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

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--") || token === "--") {
      fail(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
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

  values["timeout-ms"] = Number(values["timeout-ms"]);
  if (!Number.isFinite(values["timeout-ms"]) || values["timeout-ms"] <= 0) {
    fail("--timeout-ms must be a positive number");
  }

  values["max-bundle-bytes"] = Number(values["max-bundle-bytes"]);
  values["max-output-bytes"] = Number(values["max-output-bytes"]);

  return values;
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

  // 1. Inspect input bundle and paired basis with bounded no-follow checks
  const bundleBytes = assertRegularFile(bundlePath, args["max-bundle-bytes"], "bundle");
  const basisBytes = assertRegularFile(basisPath, MAX_BASIS_BYTES, "paired-basis");

  const bundleDigest = hashFile(bundlePath);
  const basisDigest = hashFile(basisPath);

  let basisJson;
  try {
    basisJson = JSON.parse(readFileSync(basisPath, "utf8"));
  } catch (err) {
    fail(`failed to parse paired basis JSON: ${err.message}`);
  }

  // 2. Prepare output directory
  mkdirSync(outDir, { recursive: true });

  // 3. Execute producer command: assay trust-card generate BUNDLE --out-dir DIR
  const spawnResult = spawnSync(
    assayBin,
    ["trust-card", "generate", bundlePath, "--out-dir", outDir],
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

  // 4. Verify produced trustcard.json
  const cardPath = join(outDir, "trustcard.json");
  const cardBytes = assertRegularFile(cardPath, maxOutputBytes, "trustcard.json");
  const cardDigest = hashFile(cardPath);

  let cardJson;
  try {
    cardJson = JSON.parse(readFileSync(cardPath, "utf8"));
  } catch (err) {
    fail(`produced trustcard.json is not valid JSON: ${err.message}`);
  }

  // 5. Run pure structural and parity validation
  const validation = validateTrustCardCompatibility(cardJson, basisJson);

  // 6. Retain inputs and diagnostic
  const retainedBundle = join(outDir, "bundle.evidence.tar.gz");
  if (bundlePath !== retainedBundle) {
    copyFileSync(bundlePath, retainedBundle);
  }

  const retainedBasis = join(outDir, "paired.trust-basis.json");
  if (basisPath !== retainedBasis) {
    copyFileSync(basisPath, retainedBasis);
  }

  const diagnostic = {
    schema: "assay.trust_card_compat_diagnostic.v1",
    timestamp: new Date().toISOString(),
    valid: validation.valid,
    claims_parity: validation.valid,
    bundle: {
      path: bundlePath,
      sha256: bundleDigest,
      bytes: bundleBytes,
    },
    paired_basis: {
      path: basisPath,
      sha256: basisDigest,
      bytes: basisBytes,
    },
    trust_card: {
      path: cardPath,
      sha256: cardDigest,
      bytes: cardBytes,
      schema_version: cardJson?.schema_version,
      claim_count: Array.isArray(cardJson?.claims) ? cardJson.claims.length : 0,
    },
    parity_claim:
      "Parity confirms card claims match paired trust basis claims for the measured invocation; it does not authenticate same-bundle origin across arbitrary bundles.",
    errors: validation.errors,
  };

  const diagnosticPath = join(outDir, "diagnostic.json");
  writeFileSync(diagnosticPath, JSON.stringify(diagnostic, null, 2) + "\n", "utf8");

  if (!validation.valid) {
    const errorDetails = validation.errors.map((e) => `  - [${e.code}] ${e.message}`).join("\n");
    fail(`Trust Card compatibility validation failed:\n${errorDetails}`);
  }

  process.stdout.write(
    `[probe-trust-card-compat] OK: Trust Card schema ${cardJson.schema_version} compatible, 10 claims match paired basis.\n`,
  );
}

main();
