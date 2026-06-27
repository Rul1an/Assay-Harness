import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { EXIT } from "./cli_exit.js";

export function cmdBaseline(args: Record<string, string | boolean>): void {
  const subcommand = args._file as string;
  const baselineDir = (args.dir as string) ?? resolve(process.cwd(), "baselines");
  const baselinePath = resolve(baselineDir, "baseline.assay.ndjson");

  if (!subcommand || subcommand === "path") {
    // Show the current baseline path
    console.log(baselinePath);
    if (existsSync(baselinePath)) {
      const content = readFileSync(baselinePath, "utf-8");
      const lineCount = content.trim().split("\n").filter((l) => l.length > 0).length;
      console.log(`[baseline] exists: ${lineCount} events`);
    } else {
      console.log(`[baseline] not found`);
    }
    process.exit(EXIT.SUCCESS);
  }

  if (subcommand === "show") {
    if (!existsSync(baselinePath)) {
      console.error(`[config_error] No baseline found at: ${baselinePath}`);
      process.exit(EXIT.CONFIG_ERROR);
    }
    const content = readFileSync(baselinePath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    console.log(`[baseline] ${baselinePath}`);
    console.log(`[baseline] events: ${lines.length}`);

    // Show event types and summary
    const types = new Set<string>();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        types.add(event.type);
      } catch { /* skip */ }
    }
    for (const type of [...types].sort()) {
      console.log(`  - ${type}`);
    }
    process.exit(EXIT.SUCCESS);
  }

  if (subcommand === "update") {
    const fromPath = args.from as string;
    if (!fromPath) {
      console.error(`[config_error] --from is required for baseline update`);
      console.error(`Usage: baseline update --from <evidence.ndjson> [--dir <baselines/>]`);
      process.exit(EXIT.CONFIG_ERROR);
    }
    if (!existsSync(fromPath)) {
      console.error(`[config_error] Source file not found: ${fromPath}`);
      process.exit(EXIT.CONFIG_ERROR);
    }

    // Verify the source file is valid evidence
    const content = readFileSync(fromPath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);

    // Basic validation: each line must be valid JSON with required fields
    for (let i = 0; i < lines.length; i++) {
      try {
        const event = JSON.parse(lines[i]);
        if (!event.specversion || !event.type || !event.assayrunid) {
          console.error(`[artifact_contract] Line ${i + 1}: missing required envelope fields`);
          process.exit(EXIT.ARTIFACT_CONTRACT);
        }
      } catch {
        console.error(`[artifact_contract] Line ${i + 1}: invalid JSON`);
        process.exit(EXIT.ARTIFACT_CONTRACT);
      }
    }

    // Create baseline directory if needed
    if (!existsSync(baselineDir)) {
      mkdirSync(baselineDir, { recursive: true });
    }

    // Copy with metadata
    copyFileSync(fromPath, baselinePath);

    // Write metadata
    const meta = {
      updated_at: new Date().toISOString().replace("+00:00", "Z"),
      source: fromPath,
      event_count: lines.length,
      source_file: basename(fromPath),
    };
    writeFileSync(
      resolve(baselineDir, "baseline.meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
      "utf-8"
    );

    console.log(`[baseline] updated: ${baselinePath}`);
    console.log(`[baseline] events: ${lines.length}`);
    console.log(`[baseline] source: ${fromPath}`);
    process.exit(EXIT.SUCCESS);
  }

  console.error(`[config_error] Unknown baseline subcommand: ${subcommand}`);
  console.error(`Usage: baseline <update|show|path> [--from <path>] [--dir <path>]`);
  process.exit(EXIT.CONFIG_ERROR);
}
