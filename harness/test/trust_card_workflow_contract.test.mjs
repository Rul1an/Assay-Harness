import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir); // harness dir
const workspaceRoot = dirname(repoRoot); // repo root
const workflowPath = join(workspaceRoot, ".github", "workflows", "harness-ci.yml");
const probeScriptPath = join(repoRoot, "scripts", "probe-trust-card-compat.mjs");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "assay-harness-tc-contract-"));
}

function makeValidClaims() {
  return [
    {
      id: "bundle_verified",
      level: "verified",
      source: "bundle_verification",
      boundary: "bundle-wide",
    },
    {
      id: "signing_evidence_present",
      level: "absent",
      source: "bundle_proof_surface",
      boundary: "proof-surfaces-only",
    },
    {
      id: "provenance_backed_claims_present",
      level: "absent",
      source: "bundle_proof_surface",
      boundary: "proof-surfaces-only",
    },
    {
      id: "delegation_context_visible",
      level: "verified",
      source: "canonical_decision_evidence",
      boundary: "supported-delegated-flows-only",
    },
    {
      id: "authorization_context_visible",
      level: "absent",
      source: "canonical_decision_evidence",
      boundary: "supported-auth-projected-flows-only",
    },
    {
      id: "containment_degradation_observed",
      level: "verified",
      source: "canonical_event_presence",
      boundary: "supported-containment-fallback-paths-only",
    },
    {
      id: "external_eval_receipt_boundary_visible",
      level: "verified",
      source: "external_evidence_receipt",
      boundary: "supported-external-eval-receipt-events-only",
      note: "Promptfoo receipt boundary visible in the baseline run.",
    },
    {
      id: "external_decision_receipt_boundary_visible",
      level: "absent",
      source: "external_decision_receipt",
      boundary: "supported-external-decision-receipt-events-only",
    },
    {
      id: "external_inventory_receipt_boundary_visible",
      level: "absent",
      source: "external_inventory_receipt",
      boundary: "supported-external-inventory-receipt-events-only",
    },
    {
      id: "applied_pack_findings_present",
      level: "absent",
      source: "pack_execution_results",
      boundary: "pack-execution-only",
    },
  ];
}

function makeValidCard() {
  return {
    schema_version: 5,
    claims: makeValidClaims(),
    non_goals: [
      "No aggregate trust score",
      "No safe/unsafe badge",
      "No correctness guarantees beyond stated claim boundaries",
    ],
  };
}

function writeFakeProducer(path, behavior = "success") {
  let scriptContent = "";
  if (behavior === "success") {
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'trust-card' || args[1] !== 'generate') {
  console.error('unknown subcommand:', args);
  process.exit(1);
}
const bundle = args[2];
if (!bundle || !fs.existsSync(bundle)) {
  console.error('bundle missing:', bundle);
  process.exit(1);
}
let outDir = '';
for (let i = 3; i < args.length; i++) {
  if (args[i] === '--out-dir') {
    outDir = args[i + 1];
    break;
  }
}
if (!outDir) {
  console.error('missing --out-dir');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
fs.writeFileSync(path.join(outDir, 'trustcard.md'), '# Trust Card\\n');
fs.writeFileSync(path.join(outDir, 'trustcard.html'), '<html></html>\\n');
process.exit(0);
`;
  } else if (behavior === "fail_exit_1") {
    scriptContent = `#!/usr/bin/env node
console.error("producer failed");
process.exit(1);
`;
  } else if (behavior === "malformed_json") {
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trustcard.json'), "{ malformed json");
process.exit(0);
`;
  } else if (behavior === "invalid_card_schema") {
    const badCard = { ...makeValidCard(), schema_version: 4 };
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trustcard.json'), JSON.stringify(${JSON.stringify(badCard)}));
process.exit(0);
`;
  } else if (behavior === "missing_output") {
    scriptContent = `#!/usr/bin/env node
process.exit(0);
`;
  } else if (behavior === "hang") {
    scriptContent = `#!/usr/bin/env node
setInterval(() => {}, 10000);
`;
  }

  writeFileSync(path, scriptContent, "utf8");
  chmodSync(path, 0o755);
}

// ---------------------------------------------------------------------------
// Group 1: Probe Script Execution with Inert Fake Producers
// ---------------------------------------------------------------------------

test("probe script succeeds with valid inert producer and matching paired basis", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "success");

    const bundlePath = join(dir, "baseline.evidence.tar.gz");
    writeFileSync(bundlePath, "fake-tarball-content-for-bundle\n", "utf8");

    const basisPath = join(dir, "baseline.trust-basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }, null, 2), "utf8");

    const outDir = join(dir, "out");

    const run = spawnSync(
      process.execPath,
      [
        probeScriptPath,
        "--assay-bin",
        fakeAssayBin,
        "--bundle",
        bundlePath,
        "--paired-basis",
        basisPath,
        "--out-dir",
        outDir,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );

    assert.equal(
      run.status,
      0,
      `probe expected exit 0, got ${run.status}. stderr: ${run.stderr}\nstdout: ${run.stdout}`,
    );

    // Verify outputs in outDir
    const cardContent = readFileSync(join(outDir, "trustcard.json"), "utf8");
    const parsedCard = JSON.parse(cardContent);
    assert.equal(parsedCard.schema_version, 5);

    const diagPath = join(outDir, "diagnostic.json");
    assert.ok(readFileSync(diagPath, "utf8"), "diagnostic.json must exist");
    const diag = JSON.parse(readFileSync(diagPath, "utf8"));
    assert.equal(diag.valid, true);
    assert.equal(diag.claims_parity, true);
    assert.ok(diag.bundle.sha256.startsWith("sha256:"));
    assert.ok(diag.paired_basis.sha256.startsWith("sha256:"));
    assert.ok(diag.trust_card.sha256.startsWith("sha256:"));

    // Verify bundle and paired basis retained in outDir
    assert.ok(readFileSync(join(outDir, "bundle.evidence.tar.gz")), "retained bundle must exist");
    assert.ok(readFileSync(join(outDir, "paired.trust-basis.json")), "retained paired basis must exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when assay-bin executable is missing", () => {
  const dir = tempDir();
  try {
    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));
    const outDir = join(dir, "out");

    const run = spawnSync(
      process.execPath,
      [
        probeScriptPath,
        "--assay-bin",
        join(dir, "nonexistent-assay-binary"),
        "--bundle",
        bundlePath,
        "--paired-basis",
        basisPath,
        "--out-dir",
        outDir,
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "missing binary must cause nonzero exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer exits nonzero", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "fail_exit_1");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));
    const outDir = join(dir, "out");

    const run = spawnSync(
      process.execPath,
      [
        probeScriptPath,
        "--assay-bin",
        fakeAssayBin,
        "--bundle",
        bundlePath,
        "--paired-basis",
        basisPath,
        "--out-dir",
        outDir,
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "producer exit 1 must cause probe nonzero exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer produces malformed JSON", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "malformed_json");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));
    const outDir = join(dir, "out");

    const run = spawnSync(
      process.execPath,
      [
        probeScriptPath,
        "--assay-bin",
        fakeAssayBin,
        "--bundle",
        bundlePath,
        "--paired-basis",
        basisPath,
        "--out-dir",
        outDir,
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "malformed JSON output must cause probe nonzero exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer produces invalid schema version", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "invalid_card_schema");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));
    const outDir = join(dir, "out");

    const run = spawnSync(
      process.execPath,
      [
        probeScriptPath,
        "--assay-bin",
        fakeAssayBin,
        "--bundle",
        bundlePath,
        "--paired-basis",
        basisPath,
        "--out-dir",
        outDir,
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "invalid schema version must cause probe nonzero exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer produces no trustcard.json", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "missing_output");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));
    const outDir = join(dir, "out");

    const run = spawnSync(
      process.execPath,
      [
        probeScriptPath,
        "--assay-bin",
        fakeAssayBin,
        "--bundle",
        bundlePath,
        "--paired-basis",
        basisPath,
        "--out-dir",
        outDir,
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "missing output must cause probe nonzero exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer times out", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "hang");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));
    const outDir = join(dir, "out");

    const run = spawnSync(
      process.execPath,
      [
        probeScriptPath,
        "--assay-bin",
        fakeAssayBin,
        "--bundle",
        bundlePath,
        "--paired-basis",
        basisPath,
        "--out-dir",
        outDir,
        "--timeout-ms",
        "500",
      ],
      { encoding: "utf8", timeout: 5_000 },
    );

    assert.notEqual(run.status, 0, "producer timeout must cause probe nonzero exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when paired basis claims differ from card claims", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "success");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");

    // Differing basis claims
    const differingClaims = makeValidClaims();
    differingClaims[0] = { ...differingClaims[0], level: "absent" };
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: differingClaims }), "utf8");
    const outDir = join(dir, "out");

    const run = spawnSync(
      process.execPath,
      [
        probeScriptPath,
        "--assay-bin",
        fakeAssayBin,
        "--bundle",
        bundlePath,
        "--paired-basis",
        basisPath,
        "--out-dir",
        outDir,
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "differing claims must cause probe nonzero exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Group 2: Workflow Structure and Effective Wiring Contract
// ---------------------------------------------------------------------------

function parseWorkflowJob(workflowContent, jobName) {
  const lines = workflowContent.split("\n");
  let inJobs = false;
  let inTargetJob = false;
  let targetJobLines = [];
  let currentJobIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^jobs:/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    const jobMatch = line.match(/^  ([a-zA-Z0-9_-]+):/);
    if (jobMatch) {
      const name = jobMatch[1];
      if (name === jobName) {
        inTargetJob = true;
        currentJobIndent = 2;
        targetJobLines.push(line);
        continue;
      } else if (inTargetJob) {
        break; // reached next job
      }
    } else if (inTargetJob) {
      targetJobLines.push(line);
    }
  }

  return targetJobLines.join("\n");
}

test("workflow maintains checksum-before-extraction order in binary download", () => {
  const content = readFileSync(workflowPath, "utf8");
  const jobText = parseWorkflowJob(content, "assay-release-compatibility");
  assert.ok(jobText.length > 0, "assay-release-compatibility job must exist");

  const shaIdx = jobText.indexOf("sha256sum -c");
  const tarIdx = jobText.indexOf("tar -xzf");
  assert.ok(shaIdx !== -1, "sha256sum -c must be present in download step");
  assert.ok(tarIdx !== -1, "tar -xzf must be present in download step");
  assert.ok(
    shaIdx < tarIdx,
    `checksum-before-extraction invariant violated: sha256sum at ${shaIdx}, tar at ${tarIdx}`,
  );
});

test("workflow wires Measure released Assay Trust Card compatibility step effectively", () => {
  const content = readFileSync(workflowPath, "utf8");
  const jobText = parseWorkflowJob(content, "assay-release-compatibility");
  assert.ok(jobText.length > 0, "assay-release-compatibility job must exist");

  // Step name
  assert.match(
    jobText,
    /name:\s*Measure released Assay Trust Card compatibility/,
    "step 'Measure released Assay Trust Card compatibility' must exist in job",
  );

  // Script invocation
  assert.match(
    jobText,
    /node\s+harness\/scripts\/probe-trust-card-compat\.mjs/,
    "must invoke probe-trust-card-compat.mjs",
  );

  // Build dependency
  assert.match(
    jobText,
    /npm\s+(--prefix\s+harness\s+run\s+build|run\s+build)/,
    "must explicitly build TypeScript before executing probe",
  );

  // Parameter bindings
  assert.match(
    jobText,
    /--assay-bin\s+["']?\$ASSAY_BIN["']?/,
    "must bind --assay-bin to $ASSAY_BIN",
  );
  assert.match(
    jobText,
    /--bundle\s+results\/assay-release-compatibility\/promptfoo-nonregression\/baseline\/baseline\.evidence\.tar\.gz/,
    "must bind --bundle to promptfoo nonregression baseline bundle",
  );
  assert.match(
    jobText,
    /--paired-basis\s+results\/assay-release-compatibility\/promptfoo-nonregression\/baseline\/baseline\.trust-basis\.json/,
    "must bind --paired-basis to promptfoo nonregression baseline trust-basis.json",
  );
  assert.match(
    jobText,
    /--out-dir\s+results\/assay-release-compatibility\/promptfoo-nonregression\/trustcard/,
    "must output to results/assay-release-compatibility/promptfoo-nonregression/trustcard",
  );

  // Upload glob covers results/assay-release-compatibility/**
  assert.match(
    jobText,
    /path:\s*results\/assay-release-compatibility\/\*\*/,
    "artifact upload must cover results/assay-release-compatibility/**",
  );
});

// Mutation controls for the workflow contract
test("workflow contract test bites if probe invocation is deleted or commented out", () => {
  const content = readFileSync(workflowPath, "utf8");
  const mutated = content.replace(
    /node\s+harness\/scripts\/probe-trust-card-compat\.mjs/g,
    "# deleted probe invocation",
  );
  const jobText = parseWorkflowJob(mutated, "assay-release-compatibility");
  assert.equal(
    /node\s+harness\/scripts\/probe-trust-card-compat\.mjs/.test(jobText),
    false,
    "mutation must bite when probe invocation is removed",
  );
});

test("workflow contract test bites if explicit build is deleted", () => {
  const content = readFileSync(workflowPath, "utf8");
  const mutated = content.replace(/npm\s+--prefix\s+harness\s+run\s+build/g, "");
  const jobText = parseWorkflowJob(mutated, "assay-release-compatibility");
  assert.equal(
    /npm\s+--prefix\s+harness\s+run\s+build/.test(jobText),
    false,
    "mutation must bite when build dependency is removed",
  );
});
