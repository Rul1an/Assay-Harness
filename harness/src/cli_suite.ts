import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "./cli_exit.js";
import {
  driftAgainstRegistry,
  formatSuiteMarkdown,
  formatSuiteSummary,
  loadSuiteReport,
  validateSuiteCompatibility,
} from "./suite_compatibility.js";
import {
  buildEvidencePack,
  formatPackMarkdown,
  verifyEvidencePack,
} from "./suite_evidence_pack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Single source of truth for the Harness version; also stamped into recipe provenance,
 *  so the pack's metadata cross-check (producer.version == provenance.harness.version) can
 *  never silently drift on a version bump. */
const HARNESS_VERSION: string = (() => {
  try {
    const v = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8")).version;
    // A missing/non-string version does not throw, so validate it explicitly — otherwise an
    // `undefined` would flow into producer.version and trip the metadata cross-check.
    return typeof v === "string" && v.length > 0 ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function suiteFormat(args: Record<string, string | boolean>): "markdown" | "json" {
  const format = (args.format as string | undefined) ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    console.error(`[config_error] --format must be markdown or json; got ${format}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  return format;
}

function suiteMatrixPath(args: Record<string, string | boolean>): string {
  const p = args.matrix;
  if (typeof p !== "string" || p.length === 0) {
    console.error("[config_error] --matrix <suite.compatibility.json> is required (must be a non-empty path)");
    process.exit(EXIT.CONFIG_ERROR);
  }
  return p;
}

export function cmdSuite(args: Record<string, string | boolean>): void {
  const subcommand = args._file as string | undefined;
  if (subcommand === "check") {
    cmdSuiteCheck(args);
    return;
  }
  if (subcommand === "matrix") {
    cmdSuiteMatrix(args);
    return;
  }
  console.error("[config_error] unknown suite subcommand; expected: check | matrix");
  console.error("Usage: suite check --matrix <path> [--against-registry]");
  console.error("       suite matrix --matrix <path> [--format markdown|json]");
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdSuiteCheck(args: Record<string, string | boolean>): void {
  const matrixPath = suiteMatrixPath(args);
  const load = loadSuiteReport(matrixPath);
  if (load.not_found) {
    console.error(`[config_error] Suite compatibility matrix not found: ${matrixPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;
  const errors = [...report.validation.errors];
  // Drift vs the live carrier registry is opt-in, so matrix-only validation can
  // run without coupling to the Harness registry internals.
  if (args["against-registry"] === true && report.validation.matrix) {
    errors.push(...driftAgainstRegistry(report.validation.matrix));
  }
  console.log(formatSuiteSummary(report));

  // Exit routing (contract artifact, not a producer-valid carrier): a malformed
  // matrix, unknown enum state, digest mismatch, a `proven` end-to-end claim
  // without its hosted_run + artifact_digest, or (registry mode) drift is a
  // contract error (3). `declared` end-to-end is NOT a failure; it is visible
  // pending-proof. No `6` here. Missing file / bare --matrix -> config_error (2).
  if (errors.length > 0) {
    const codes = errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] suite check: matrix not consistent (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdSuiteMatrix(args: Record<string, string | boolean>): void {
  const matrixPath = suiteMatrixPath(args);
  const format = suiteFormat(args);
  const load = loadSuiteReport(matrixPath);
  if (load.not_found) {
    console.error(`[config_error] Suite compatibility matrix not found: ${matrixPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  // `--format json` emits only the JSON document on stdout so it stays parseable
  // (the matrix is later Evidence Pack input); the summary goes to the markdown path.
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSuiteMarkdown(report).trimEnd());
    console.log(formatSuiteSummary(report));
  }
  // Set exitCode and return rather than process.exit(): the JSON document can exceed the stdout
  // pipe buffer (~8 KB), and process.exit() terminates before the async piped write drains, which
  // would truncate machine-readable output while still exiting 0 (artifact-contract poison). The
  // top-level dispatch has no further process.exit(), so the event loop flushes stdout, then Node
  // exits with process.exitCode. (Other commands still process.exit(); they emit small output.)
  if (!report.validation.valid) {
    const codes = report.validation.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] suite matrix: invalid matrix (${codes})`);
    process.exitCode = EXIT.ARTIFACT_CONTRACT;
    return;
  }
  process.exitCode = EXIT.SUCCESS;
}

function evidencePackArg(args: Record<string, string | boolean>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.length === 0) {
    console.error(`[config_error] --${name} <path> is required`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  return v;
}

export function cmdEvidencePack(args: Record<string, string | boolean>): void {
  const subcommand = args._file as string | undefined;
  if (subcommand === "create") {
    cmdEvidencePackCreate(args);
    return;
  }
  if (subcommand === "verify") {
    cmdEvidencePackVerify(args);
    return;
  }
  console.error("[config_error] unknown evidence-pack subcommand; expected: create | verify");
  console.error("Usage: evidence-pack create --carrier <p> --suite-matrix <p> --provenance <p> --markdown <p> --out <dir>");
  console.error("       evidence-pack verify <dir> [--format markdown|json]");
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdEvidencePackCreate(args: Record<string, string | boolean>): void {
  const outDir = args.out;
  if (typeof outDir !== "string" || outDir.length === 0) {
    console.error("[config_error] --out <dir> is required");
    process.exit(EXIT.CONFIG_ERROR);
  }
  const inputs = {
    carrierPath: evidencePackArg(args, "carrier"),
    suiteMatrixPath: evidencePackArg(args, "suite-matrix"),
    provenancePath: evidencePackArg(args, "provenance"),
    markdownPath: evidencePackArg(args, "markdown"),
    // Derived from package.json so it cannot drift from the recipe's harness.version.
    harnessVersion: HARNESS_VERSION,
  };
  try {
    const manifest = buildEvidencePack(inputs, outDir);
    console.error(`[evidence-pack] wrote ${outDir} (digest ${manifest.manifest.digest})`);
    // Fail closed: a pack we just built must self-verify.
    const v = verifyEvidencePack(outDir);
    if (!v.valid) {
      console.error(`[ci_formatter] built pack failed self-verify: ${v.errors.map((e) => e.code).join(",")}`);
      process.exit(EXIT.CI_FORMATTER);
    }
  } catch (e) {
    console.error(`[ci_formatter] evidence-pack create failed: ${(e as Error).message}`);
    process.exit(EXIT.CI_FORMATTER);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdEvidencePackVerify(args: Record<string, string | boolean>): void {
  // `evidence-pack verify <dir>` -> the dir is the third positional (_subfile); --pack also works.
  const packDir = (args._subfile as string | undefined) ?? (args.pack as string | undefined);
  if (typeof packDir !== "string" || packDir.length === 0) {
    console.error("[config_error] evidence-pack verify <dir> requires a pack directory");
    process.exit(EXIT.CONFIG_ERROR);
  }
  const format = suiteFormat(args);
  const result = verifyEvidencePack(packDir);

  // `--format json` emits only the JSON document on stdout so it stays parseable.
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.manifest) console.log(formatPackMarkdown(result.manifest));
    console.log(`[evidence-pack] ${result.valid ? "VALID" : "INVALID"}`);
  }
  if (!result.valid) {
    console.error(`[artifact_contract] evidence-pack verify: ${result.errors.map((e) => e.code).join(",")}`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  process.exit(EXIT.SUCCESS);
}
