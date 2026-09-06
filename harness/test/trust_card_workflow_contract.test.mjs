import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { chmodSync, constants as fsConstants, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { readBoundedRegularFile } from "../scripts/probe-trust-card-compat.mjs";

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
      note: null,
    },
    {
      id: "signing_evidence_present",
      level: "absent",
      source: "bundle_proof_surface",
      boundary: "proof-surfaces-only",
      note: null,
    },
    {
      id: "provenance_backed_claims_present",
      level: "absent",
      source: "bundle_proof_surface",
      boundary: "proof-surfaces-only",
      note: null,
    },
    {
      id: "delegation_context_visible",
      level: "verified",
      source: "canonical_decision_evidence",
      boundary: "supported-delegated-flows-only",
      note: null,
    },
    {
      id: "authorization_context_visible",
      level: "absent",
      source: "canonical_decision_evidence",
      boundary: "supported-auth-projected-flows-only",
      note: null,
    },
    {
      id: "containment_degradation_observed",
      level: "verified",
      source: "canonical_event_presence",
      boundary: "supported-containment-fallback-paths-only",
      note: null,
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
      note: null,
    },
    {
      id: "external_inventory_receipt_boundary_visible",
      level: "absent",
      source: "external_inventory_receipt",
      boundary: "supported-external-inventory-receipt-events-only",
      note: null,
    },
    {
      id: "applied_pack_findings_present",
      level: "absent",
      source: "pack_execution_results",
      boundary: "pack-execution-only",
      note: null,
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
    // Isolating RED for exit code (M5): writes valid card THEN exits 1
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') {
    outDir = args[i + 1];
    break;
  }
}
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
  fs.writeFileSync(path.join(outDir, 'trustcard.md'), '# Trust Card\\n');
  fs.writeFileSync(path.join(outDir, 'trustcard.html'), '<html></html>\\n');
}
console.error("producer failed deliberately");
process.exit(1);
`;
  } else if (behavior === "missing_output") {
    // Producer exits 0 but writes no trustcard.json
    scriptContent = `#!/usr/bin/env node
process.exit(0);
`;
  } else if (behavior === "oversized_output") {
    // Producer writes a valid card whose size exceeds 1000 bytes
    const bigCard = makeValidCard();
    bigCard.claims[0].note = "X".repeat(2000);
    const cardJson = JSON.stringify(bigCard, null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') {
    outDir = args[i + 1];
    break;
  }
}
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
}
process.exit(0);
`;
  } else if (behavior === "mutates_bundle") {
    // Producer mutates the retained bundle during execution (P6)
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const bundle = args[2];
if (bundle && fs.existsSync(bundle)) {
  fs.appendFileSync(bundle, 'HOSTILE-MUTATION-AFTER-HASH\\n');
}
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') {
    outDir = args[i + 1];
    break;
  }
}
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
}
process.exit(0);
`;
  } else if (behavior === "mutates_basis") {
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
if (outDir) {
  const basis = path.join(outDir, 'paired.trust-basis.json');
  if (fs.existsSync(basis)) {
    fs.appendFileSync(basis, 'HOSTILE-MUTATION-AFTER-HASH\\n');
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
}
process.exit(0);
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
  } else if (behavior === "grows_bundle") {
    // Producer appends bytes to retained bundle making it exceed ceiling
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const bundle = args[2];
if (bundle && fs.existsSync(bundle)) {
  fs.appendFileSync(bundle, 'Z'.repeat(1000));
}
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
}
process.exit(0);
`;
  } else if (behavior === "symlink_bundle") {
    // Producer replaces retained bundle with a symlink
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const bundle = args[2];
if (bundle && fs.existsSync(bundle)) {
  const realCopy = bundle + '.real';
  fs.renameSync(bundle, realCopy);
  fs.symlinkSync(realCopy, bundle);
}
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
}
process.exit(0);
`;
  } else if (behavior === "symlink_basis") {
    // Producer replaces retained basis with a symlink
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
if (outDir) {
  const basis = path.join(outDir, 'paired.trust-basis.json');
  if (fs.existsSync(basis)) {
    const realCopy = basis + '.real';
    fs.renameSync(basis, realCopy);
    fs.symlinkSync(realCopy, basis);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
}
process.exit(0);
`;
  } else if (behavior === "symlink_card") {
    // Producer writes trustcard.json as a symlink
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const realCard = path.join(outDir, 'trustcard.json.real');
  fs.writeFileSync(realCard, ${JSON.stringify(cardJson + "\n")});
  fs.symlinkSync(realCard, path.join(outDir, 'trustcard.json'));
}
process.exit(0);
`;
  } else if (behavior === "grows_basis") {
    // Producer appends bytes to retained basis making it exceed ceiling
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
if (outDir) {
  const basis = path.join(outDir, 'paired.trust-basis.json');
  if (fs.existsSync(basis)) {
    fs.appendFileSync(basis, 'X'.repeat(1000));
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
}
process.exit(0);
`;
  } else if (behavior === "hang") {
    scriptContent = `#!/usr/bin/env node
setInterval(() => {}, 10000);
`;
  } else if (behavior === "writes_diagnostic") {
    // Producer writes valid trustcard.json AND its own diagnostic.json sentinel (G4)
    const cardJson = JSON.stringify(makeValidCard(), null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
  fs.writeFileSync(path.join(outDir, 'diagnostic.json'), '{"sentinel":"producer-created-diagnostic"}\\n');
}
process.exit(0);
`;
  } else if (behavior === "empty_claims") {
    // Producer emits card with empty claims array (H2)
    const emptyCard = makeValidCard();
    emptyCard.claims = [];
    const cardJson = JSON.stringify(emptyCard, null, 2);
    scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') { outDir = args[i + 1]; break; }
}
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trustcard.json'), ${JSON.stringify(cardJson + "\n")});
}
process.exit(0);
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

    const cardDigest = `sha256:${createHash("sha256").update(Buffer.from(cardContent, "utf8")).digest("hex")}`;

    const diagPath = join(outDir, "diagnostic.json");
    assert.ok(readFileSync(diagPath, "utf8"), "diagnostic.json must exist");
    const diag = JSON.parse(readFileSync(diagPath, "utf8"));
    assert.equal(diag.valid, true);
    assert.equal(diag.claims_parity, true);
    assert.match(
      diag.parity_claim,
      /across two invocations of the same producer binary on the same bundle/,
      "parity_claim must state consistency across two invocations of the same producer binary (G1)",
    );
    assert.match(
      diag.parity_claim,
      /does not authenticate same-bundle origin/,
      "parity_claim must preserve origin/authentication nonclaims (G1)",
    );
    assert.ok(diag.bundle.sha256.startsWith("sha256:"));
    assert.ok(diag.paired_basis.sha256.startsWith("sha256:"));
    assert.equal(diag.trust_card.sha256, cardDigest);
    assert.equal(diag.trust_card.bytes, Buffer.byteLength(cardContent, "utf8"));
    assert.equal(diag.trust_card.schema_version, parsedCard.schema_version);
    assert.equal(diag.trust_card.claim_count, parsedCard.claims.length);

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

test("probe script fails when produced trustcard.json exceeds max-output-bytes (M4)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "oversized_output");

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
        "--max-output-bytes",
        "1000",
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "oversized output must cause probe nonzero exit");
    assert.match(run.stderr, /exceeds ceiling 1000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when bundle exceeds max-bundle-bytes (P2a)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "success");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "X".repeat(5000));
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
        "--max-bundle-bytes",
        "1000",
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "oversized bundle must cause probe nonzero exit");
    assert.match(run.stderr, /exceeds ceiling 1000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script refuses pre-existing trustcard.json in output directory (P1 / F3)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "missing_output");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));
    const outDir = join(dir, "out");

    // Pre-create valid trustcard.json in outDir
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "trustcard.json"), JSON.stringify(makeValidCard()));

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

    assert.notEqual(run.status, 0, "pre-existing output artifact must cause probe nonzero exit");
    assert.match(run.stderr, /pre-existing trustcard\.json found in out-dir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when retained bundle is mutated during producer execution (P6 / F4)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "mutates_bundle");

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

    assert.notEqual(run.status, 0, "mutated retained bundle must cause probe nonzero exit");
    assert.match(run.stderr, /retained bundle mutated during producer execution/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when retained paired basis is mutated during producer execution (F4 residual)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "mutates_basis");

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

    assert.notEqual(run.status, 0, "mutated retained paired basis must cause probe nonzero exit");
    assert.match(run.stderr, /retained paired basis mutated during producer execution/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script refuses pre-existing retained bundle in output directory and preserves its bytes (F3 residual)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "missing_output");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "fresh-bundle-bytes\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));

    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });
    const existingRetainedBundle = join(outDir, "bundle.evidence.tar.gz");
    const historicalContent = "HISTORICAL-RETAINED-BUNDLE-PRESERVED\n";
    writeFileSync(existingRetainedBundle, historicalContent);

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

    assert.notEqual(run.status, 0, "pre-existing retained bundle must fail closed");
    assert.match(run.stderr, /pre-existing run artifacts found in out-dir/);
    assert.equal(
      readFileSync(existingRetainedBundle, "utf8"),
      historicalContent,
      "pre-existing retained bundle must remain byte-identical after refused run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer grows retained bundle past size ceiling (F4 residual)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "grows_bundle");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "small\n");
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
        "--max-bundle-bytes",
        "500",
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "oversized post-execution retained bundle must fail closed");
    assert.match(run.stderr, /retained bundle size \d+ exceeds ceiling 500/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer substitutes retained bundle with a symlink (F4 residual)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "symlink_bundle");

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

    assert.notEqual(run.status, 0, "symlink-substituted retained bundle must fail closed");
    assert.match(run.stderr, /must not be a symbolic link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script refuses pre-existing retained paired basis in output directory and preserves its bytes (F3 residual)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "missing_output");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "fresh-bundle-bytes\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));

    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });
    const existingRetainedBasis = join(outDir, "paired.trust-basis.json");
    const historicalContent = "{\"historical\": \"paired-basis-bytes\"}\n";
    writeFileSync(existingRetainedBasis, historicalContent);

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

    assert.notEqual(run.status, 0, "pre-existing retained basis must fail closed");
    assert.match(run.stderr, /pre-existing run artifacts found in out-dir/);
    assert.equal(
      readFileSync(existingRetainedBasis, "utf8"),
      historicalContent,
      "pre-existing retained paired basis must remain byte-identical after refused run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script refuses pre-existing diagnostic in output directory and preserves its bytes (F3 residual)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "missing_output");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "fresh-bundle-bytes\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));

    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });
    const existingDiag = join(outDir, "diagnostic.json");
    const historicalContent = "{\"historical\": \"prior-diagnostic-run\"}\n";
    writeFileSync(existingDiag, historicalContent);

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

    assert.notEqual(run.status, 0, "pre-existing diagnostic must fail closed");
    assert.match(run.stderr, /pre-existing run artifacts found in out-dir/);
    assert.equal(
      readFileSync(existingDiag, "utf8"),
      historicalContent,
      "pre-existing diagnostic must remain byte-identical after refused run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer substitutes retained paired basis with a symlink (F4 residual)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "symlink_basis");

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

    assert.notEqual(run.status, 0, "symlink-substituted retained basis must fail closed");
    assert.match(run.stderr, /must not be a symbolic link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer substitutes trustcard.json with a symlink (F4 residual)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "symlink_card");

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

    assert.notEqual(run.status, 0, "symlink-substituted trustcard must fail closed");
    assert.match(run.stderr, /must not be a symbolic link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails when producer emits its own diagnostic.json and preserves sentinel bytes (G4)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "writes_diagnostic");

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
      { encoding: "utf8", timeout: 10_000 },
    );

    assert.notEqual(run.status, 0, "probe must fail when diagnostic.json already exists");
    assert.match(run.stderr, /failed to write diagnostic/);

    const diagPath = join(outDir, "diagnostic.json");
    const preservedContent = readFileSync(diagPath, "utf8");
    assert.equal(
      preservedContent,
      '{"sentinel":"producer-created-diagnostic"}\n',
      "producer-created diagnostic.json sentinel bytes must be preserved",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script fails and records false claims_parity in diagnostic when producer emits empty claims (H2)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "empty_claims");

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
      { encoding: "utf8", timeout: 10_000 },
    );

    assert.notEqual(run.status, 0, "probe must fail when card claims are empty");
    assert.match(run.stderr, /Trust Card compatibility validation failed/);

    const diagPath = join(outDir, "diagnostic.json");
    const diag = JSON.parse(readFileSync(diagPath, "utf8"));
    assert.equal(diag.valid, false);
    assert.equal(diag.claims_parity, false, "retained diagnostic must reflect false claims_parity (H2)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedRegularFile rejects symlink without following target (F4)", () => {
  const dir = tempDir();
  try {
    const targetPath = join(dir, "target.txt");
    writeFileSync(targetPath, "payload content\n");
    const linkPath = join(dir, "link.txt");
    symlinkSync(targetPath, linkPath);

    assert.throws(
      () => readBoundedRegularFile(linkPath, 1000, "symlink_test"),
      /symlink_test must not be a symbolic link/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedRegularFile rejects non-regular directory (F4)", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => readBoundedRegularFile(dir, 1000, "dir_test"),
      /dir_test is not a regular file/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedRegularFile fails before reading when fstat reports size exceeding ceiling (no post-allocation check) (F4)", () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, "oversized.txt");
    writeFileSync(filePath, "A".repeat(2000));

    let readSyncCalls = 0;
    const spyFs = Object.assign({}, fs, {
      readSync(...args) {
        readSyncCalls++;
        return fs.readSync(...args);
      },
    });

    assert.throws(
      () => readBoundedRegularFile(filePath, 100, "ceiling_test", spyFs),
      /ceiling_test size 2000 exceeds ceiling 100/,
    );
    assert.equal(readSyncCalls, 0, "readSync must NOT be called when fstat reports size exceeding ceiling");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedRegularFile stops descriptor read at maxBytes + 1 without unbounded allocation (F4)", () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, "growing.txt");
    writeFileSync(filePath, "B".repeat(500));

    let totalBytesRead = 0;
    const spyFs = Object.assign({}, fs, {
      fstatSync(fd) {
        const realStat = fs.fstatSync(fd);
        // Simulate fstat returning a size within limit (e.g. dynamic descriptor)
        return Object.assign(Object.create(Object.getPrototypeOf(realStat)), realStat, {
          isFile: () => true,
          size: 10,
        });
      },
      readSync(fd, buf, offset, length, position) {
        const n = fs.readSync(fd, buf, offset, length, position);
        totalBytesRead += n;
        return n;
      },
    });

    assert.throws(
      () => readBoundedRegularFile(filePath, 50, "streaming_test", spyFs),
      /streaming_test size 51 exceeds ceiling 50/,
    );
    assert.equal(
      totalBytesRead,
      51,
      "read loop must immediately halt at maxBytes + 1 without reading full file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedRegularFile returns exact buffer for regular file within ceiling (F4)", () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, "valid.txt");
    const content = "exact expected buffer content\n";
    writeFileSync(filePath, content);

    const buf = readBoundedRegularFile(filePath, 1000, "valid_test");
    assert.equal(buf.toString("utf8"), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedRegularFile includes O_NONBLOCK in open flags to prevent blocking acquisition (G5)", () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, "test-flags.txt");
    writeFileSync(filePath, "regular-file-content\n");

    let capturedFlags = null;
    const spyFs = Object.assign({}, fs, {
      openSync(path, flags, ...rest) {
        capturedFlags = flags;
        return fs.openSync(path, flags, ...rest);
      },
    });

    const buf = readBoundedRegularFile(filePath, 1000, "flags_test", spyFs);
    assert.equal(buf.toString("utf8"), "regular-file-content\n");
    assert.notEqual(capturedFlags, null, "openSync must be called");
    assert.notEqual(
      fsConstants.O_NONBLOCK,
      undefined,
      "fsConstants.O_NONBLOCK must be defined on supported platform",
    );
    assert.equal(
      capturedFlags & fsConstants.O_NONBLOCK,
      fsConstants.O_NONBLOCK,
      "openSync flags must include O_NONBLOCK",
    );
    assert.equal(
      capturedFlags & (fsConstants.O_NOFOLLOW ?? 0),
      fsConstants.O_NOFOLLOW ?? 0,
      "openSync flags must include O_NOFOLLOW",
    );

    // Outcome control: simulated non-regular file is rejected by isFile() check
    const spyNonRegularFs = Object.assign({}, fs, {
      fstatSync(fd) {
        const realStat = fs.fstatSync(fd);
        return Object.assign(Object.create(Object.getPrototypeOf(realStat)), realStat, {
          isFile: () => false,
        });
      },
    });
    assert.throws(
      () => readBoundedRegularFile(filePath, 1000, "nonregular_test", spyNonRegularFs),
      /nonregular_test is not a regular file/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script rejects non-integer or out-of-contract resource ceilings (P2b, P2c / F5)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "success");

    const bundlePath = join(dir, "bundle.tar.gz");
    writeFileSync(bundlePath, "data\n");
    const basisPath = join(dir, "basis.json");
    writeFileSync(basisPath, JSON.stringify({ claims: makeValidClaims() }));
    const outDir = join(dir, "out");

    // Non-integer max-bundle-bytes (P2b)
    let run = spawnSync(
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
        "--max-bundle-bytes",
        "notanumber",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(run.status, 0, "non-integer max-bundle-bytes must fail");
    assert.match(run.stderr, /--max-bundle-bytes must be a positive integer/);

    // Non-integer max-output-bytes (P2c)
    run = spawnSync(
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
        "--max-output-bytes",
        "notanumber",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(run.status, 0, "non-integer max-output-bytes must fail");
    assert.match(run.stderr, /--max-output-bytes must be a positive integer/);

    // Negative timeout-ms
    run = spawnSync(
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
        "-50",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(run.status, 0, "negative timeout-ms must fail");
    assert.match(run.stderr, /--timeout-ms must be a positive integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script rejects unknown CLI options (P2d / F5)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "success");

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
        "--totally-unknown-flag",
        "zzz",
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "unknown CLI options must cause nonzero exit");
    assert.match(run.stderr, /unknown option: --totally-unknown-flag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe script rejects duplicate CLI options (F5)", () => {
  const dir = tempDir();
  try {
    const fakeAssayBin = join(dir, "assay");
    writeFakeProducer(fakeAssayBin, "success");

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
        "1000",
        "--timeout-ms",
        "2000",
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(run.status, 0, "duplicate CLI options must cause nonzero exit");
    assert.match(run.stderr, /duplicate option: --timeout-ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Group 2: Workflow Structure and Effective Wiring Contract (F1, F2, F7)
// ---------------------------------------------------------------------------

export function assertTrustCardStepWiring(workflow) {
  assert.ok(workflow && typeof workflow === "object", "workflow must be a parsed object");
  const compJob = workflow.jobs?.["assay-release-compatibility"];
  assert.ok(compJob, "assay-release-compatibility job must exist in workflow");
  assert.equal(compJob["continue-on-error"], undefined, "job must not be non-blocking");

  const steps = compJob.steps;
  assert.ok(Array.isArray(steps), "job must contain steps array");

  const step = steps.find((s) => s?.name === "Measure released Assay Trust Card compatibility");
  assert.ok(step, "missing 'Measure released Assay Trust Card compatibility' step");

  // Effective wiring invariants: step must be unconditional and blocking (F1/M7)
  assert.equal(Object.hasOwn(step, "if"), false, "step must not be conditional (no if:)");
  assert.equal(Object.hasOwn(step, "continue-on-error"), false, "step must not continue on error");

  const runScript = String(step.run ?? "");
  assert.ok(runScript.trim().length > 0, "step must have non-empty run script");

  // Comment filter: commented lines must not satisfy command presence (F1/M6)
  const activeLines = runScript
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .join("\n");

  assert.match(
    activeLines,
    /\bnode\s+harness\/scripts\/probe-trust-card-compat\.mjs\b/,
    "must invoke probe-trust-card-compat.mjs as an active uncommented command",
  );

  assert.match(
    activeLines,
    /\bnpm\s+--prefix\s+harness\s+run\s+build\b/,
    "must explicitly build TypeScript before executing probe",
  );

  assert.match(
    activeLines,
    /--assay-bin\s+["']?\$ASSAY_BIN["']?/,
    "must bind --assay-bin to $ASSAY_BIN",
  );
  assert.match(
    activeLines,
    /--bundle\s+results\/assay-release-compatibility\/promptfoo-nonregression\/baseline\/baseline\.evidence\.tar\.gz/,
    "must bind --bundle to promptfoo nonregression baseline bundle",
  );
  assert.match(
    activeLines,
    /--paired-basis\s+results\/assay-release-compatibility\/promptfoo-nonregression\/baseline\/baseline\.trust-basis\.json/,
    "must bind --paired-basis to promptfoo nonregression baseline trust-basis.json",
  );
  assert.match(
    activeLines,
    /--out-dir\s+results\/assay-release-compatibility\/promptfoo-nonregression\/trustcard/,
    "must output to results/assay-release-compatibility/promptfoo-nonregression/trustcard",
  );

  // Behavioral shell failure propagation invariant (H1):
  // The actual YAML-selected step must propagate a reached failing probe (exit 23 -> exit 23)
  // and pass a successful probe (exit 0 -> exit 0) with inert npm/node interception.
  assertTrustCardStepFailurePropagation(runScript);

  const uploadStep = steps.find((s) => String(s?.uses ?? "").startsWith("actions/upload-artifact@"));
  assert.ok(uploadStep, "missing upload-artifact step");
  assert.match(
    String(uploadStep?.with?.path ?? ""),
    /results\/assay-release-compatibility\/\*\*/,
    "artifact upload must cover results/assay-release-compatibility/**",
  );

  const downloadStep = steps.find(
    (s) => s?.name === "Download Assay release binary" || String(s?.run ?? "").includes("sha256sum -c"),
  );
  assert.ok(downloadStep, "missing release binary download step");
  const dlRun = String(downloadStep.run ?? "");
  const shaIdx = dlRun.indexOf("sha256sum -c");
  const tarIdx = dlRun.indexOf("tar -xzf");
  assert.ok(shaIdx !== -1 && tarIdx !== -1 && shaIdx < tarIdx, "checksum-before-extraction violated");
}

export function assertTrustCardStepFailurePropagation(runScript) {
  // Test failure propagation: when inert probe exits 23, the step must propagate exit 23
  const failSubprocess = spawnSync(
    "bash",
    [
      "-c",
      `npm() { return 0; }\nnode() { for arg in "$@"; do if [[ "$arg" == *"probe-trust-card-compat.mjs"* ]]; then echo "INERT_PROBE_REACHED"; return 23; fi; done; echo "UNEXPECTED_NODE_INVOCATION: $@"; return 99; }\nASSAY_BIN="inert-never-executed"\n${runScript}`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );

  assert.match(
    failSubprocess.stdout ?? "",
    /INERT_PROBE_REACHED/,
    "failing probe command was not reached or executed during step execution",
  );
  assert.equal(
    failSubprocess.status,
    23,
    `step must propagate probe nonzero exit status (expected 23, got ${failSubprocess.status}). stderr: ${failSubprocess.stderr}`,
  );

  // Positive / no-op control: when inert probe exits 0, the step must succeed with exit 0
  const passSubprocess = spawnSync(
    "bash",
    [
      "-c",
      `npm() { return 0; }\nnode() { for arg in "$@"; do if [[ "$arg" == *"probe-trust-card-compat.mjs"* ]]; then echo "INERT_PROBE_REACHED"; return 0; fi; done; echo "UNEXPECTED_NODE_INVOCATION: $@"; return 99; }\nASSAY_BIN="inert-never-executed"\n${runScript}`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );

  assert.match(
    passSubprocess.stdout ?? "",
    /INERT_PROBE_REACHED/,
    "successful probe command was not reached or executed during step execution",
  );
  assert.equal(
    passSubprocess.status,
    0,
    `step must succeed when probe exits 0 (expected 0, got ${passSubprocess.status}). stderr: ${passSubprocess.stderr}`,
  );
}

function loadHarnessWorkflow() {
  return loadYaml(readFileSync(workflowPath, "utf8"));
}

test("workflow maintains checksum-before-extraction and wires Measure released Assay Trust Card compatibility step effectively", () => {
  const workflow = loadHarnessWorkflow();
  assertTrustCardStepWiring(workflow);
});

test("workflow contract test bites if probe invocation is deleted or commented out (M6)", () => {
  const base = loadHarnessWorkflow();
  const clone = () => JSON.parse(JSON.stringify(base));

  // Commented out probe invocation line
  const commented = clone();
  const step = commented.jobs["assay-release-compatibility"].steps.find(
    (s) => s.name === "Measure released Assay Trust Card compatibility",
  );
  step.run = step.run.replace(
    /node\s+harness\/scripts\/probe-trust-card-compat\.mjs/g,
    "# node harness/scripts/probe-trust-card-compat.mjs",
  );
  assert.throws(
    () => assertTrustCardStepWiring(commented),
    /must invoke probe-trust-card-compat\.mjs as an active uncommented command/,
  );

  // Deleted probe invocation line
  const deleted = clone();
  const delStep = deleted.jobs["assay-release-compatibility"].steps.find(
    (s) => s.name === "Measure released Assay Trust Card compatibility",
  );
  delStep.run = "npm --prefix harness run build\necho skipped";
  assert.throws(
    () => assertTrustCardStepWiring(deleted),
    /must invoke probe-trust-card-compat\.mjs as an active uncommented command/,
  );
});

test("workflow contract test bites if probe step is conditional (M7)", () => {
  const base = loadHarnessWorkflow();
  const clone = () => JSON.parse(JSON.stringify(base));

  const conditional = clone();
  const step = conditional.jobs["assay-release-compatibility"].steps.find(
    (s) => s.name === "Measure released Assay Trust Card compatibility",
  );
  step.if = false;
  assert.throws(() => assertTrustCardStepWiring(conditional), /step must not be conditional/);
});

test("workflow contract test bites if probe step has continue-on-error", () => {
  const base = loadHarnessWorkflow();
  const clone = () => JSON.parse(JSON.stringify(base));

  const nonBlocking = clone();
  const step = nonBlocking.jobs["assay-release-compatibility"].steps.find(
    (s) => s.name === "Measure released Assay Trust Card compatibility",
  );
  step["continue-on-error"] = true;
  assert.throws(() => assertTrustCardStepWiring(nonBlocking), /step must not continue on error/);
});

test("workflow contract test bites if probe step is deleted (M8)", () => {
  const base = loadHarnessWorkflow();
  const clone = () => JSON.parse(JSON.stringify(base));

  const missingStep = clone();
  missingStep.jobs["assay-release-compatibility"].steps = missingStep.jobs[
    "assay-release-compatibility"
  ].steps.filter((s) => s.name !== "Measure released Assay Trust Card compatibility");
  assert.throws(
    () => assertTrustCardStepWiring(missingStep),
    /missing 'Measure released Assay Trust Card compatibility' step/,
  );
});

test("workflow contract test bites if explicit build is deleted (M9)", () => {
  const base = loadHarnessWorkflow();
  const clone = () => JSON.parse(JSON.stringify(base));

  const noBuild = clone();
  const step = noBuild.jobs["assay-release-compatibility"].steps.find(
    (s) => s.name === "Measure released Assay Trust Card compatibility",
  );
  step.run = step.run.replace(/npm\s+--prefix\s+harness\s+run\s+build/g, "# no build");
  assert.throws(
    () => assertTrustCardStepWiring(noBuild),
    /must explicitly build TypeScript before executing probe/,
  );
});

test("workflow contract test bites if bundle path is altered (M10)", () => {
  const base = loadHarnessWorkflow();
  const clone = () => JSON.parse(JSON.stringify(base));

  const wrongBundle = clone();
  const step = wrongBundle.jobs["assay-release-compatibility"].steps.find(
    (s) => s.name === "Measure released Assay Trust Card compatibility",
  );
  step.run = step.run.replace(
    /baseline\.evidence\.tar\.gz/g,
    "different-family/other.evidence.tar.gz",
  );
  assert.throws(
    () => assertTrustCardStepWiring(wrongBundle),
    /must bind --bundle to promptfoo nonregression baseline bundle/,
  );
});

test("workflow contract test bites if checksum-before-extraction order is inverted (M11)", () => {
  const base = loadHarnessWorkflow();
  const clone = () => JSON.parse(JSON.stringify(base));

  const inverted = clone();
  const step = inverted.jobs["assay-release-compatibility"].steps.find(
    (s) => s?.name === "Download Assay release binary" || String(s?.run ?? "").includes("sha256sum -c"),
  );
  // Invert sha256sum -c and tar -xzf
  step.run = "tar -xzf $dl\nsha256sum -c <<EOF\n...EOF\n";
  assert.throws(
    () => assertTrustCardStepWiring(inverted),
    /checksum-before-extraction violated/,
  );
});

test("workflow contract test bites if probe failure is suppressed with || true (H1)", () => {
  const base = loadHarnessWorkflow();
  const masked = JSON.parse(JSON.stringify(base));
  const step = masked.jobs["assay-release-compatibility"].steps.find(
    (s) => s.name === "Measure released Assay Trust Card compatibility",
  );
  step.run = step.run.replace(
    /--out-dir [^\n]+/,
    "$& || true",
  );
  assert.throws(
    () => assertTrustCardStepWiring(masked),
    /step must propagate probe nonzero exit status/,
  );
});

test("workflow contract test bites if probe command is not reached during execution (H1)", () => {
  const base = loadHarnessWorkflow();
  const unreached = JSON.parse(JSON.stringify(base));
  const step = unreached.jobs["assay-release-compatibility"].steps.find(
    (s) => s.name === "Measure released Assay Trust Card compatibility",
  );
  step.run = `set -euo pipefail\nnpm --prefix harness run build\nexit 0\n${step.run}`;
  assert.throws(
    () => assertTrustCardStepWiring(unreached),
    /failing probe command was not reached or executed during step execution/,
  );
});
