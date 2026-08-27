import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "./cli_exit.js";
import { buildEnforcementHealthProvenance } from "./enforcement_health_record.js";
import { validateRecipeProvenance } from "./suite_recipe_provenance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function argValue(argv: string[], name: string): string {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (!value || value.startsWith("--")) {
    console.error(`[config_error] --${name} is required`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  return value;
}

function harnessVersion(): string {
  const raw = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as { version?: string };
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    console.error("[config_error] harness package.json version is missing");
    process.exit(EXIT.CONFIG_ERROR);
  }
  return raw.version;
}

const argv = process.argv.slice(2);
const provenance = buildEnforcementHealthProvenance({
  hostedRun: argValue(argv, "hosted-run"),
  runnerOs: argValue(argv, "runner-os"),
  assayVersion: argValue(argv, "assay-version"),
  binaryDigest: argValue(argv, "binary-digest"),
  releaseAssetPath: argValue(argv, "release-asset-path"),
  releaseAssetDigest: argValue(argv, "release-asset-digest"),
  fixturePath: argValue(argv, "fixture-path"),
  fixtureDigest: argValue(argv, "fixture-digest"),
  artifactPath: argValue(argv, "artifact-path"),
  artifactDigest: argValue(argv, "artifact-digest"),
  harnessVersion: harnessVersion(),
});
const shape = validateRecipeProvenance(provenance);
if (!shape.valid) {
  console.error(`[artifact_contract] provenance shape invalid: ${shape.errors.map((e) => e.message).join("; ")}`);
  process.exit(EXIT.ARTIFACT_CONTRACT);
}
writeFileSync(argValue(argv, "out"), `${JSON.stringify(provenance, null, 2)}\n`);
process.stdout.write("enforcement-health provenance written\n");
