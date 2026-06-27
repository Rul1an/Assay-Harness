#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src");
const limit = 600;
const extensions = new Set([".ts", ".js", ".mjs"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
      continue;
    }
    if ([...extensions].some((ext) => entry.name.endsWith(ext))) {
      yield path;
    }
  }
}

function lineCount(path) {
  const content = readFileSync(path, "utf8");
  const newlineCount = content.match(/\n/g)?.length ?? 0;
  return newlineCount + (content.length > 0 && !content.endsWith("\n") ? 1 : 0);
}

const failures = [];
for (const path of walk(srcDir)) {
  const lines = lineCount(path);
  if (lines >= limit) {
    failures.push({ path: relative(root, path), lines });
  }
}

if (failures.length > 0) {
  console.error(`[hotspot-loc] expected every src file to stay under ${limit} lines`);
  for (const failure of failures.sort((a, b) => b.lines - a.lines)) {
    console.error(`[hotspot-loc] ${failure.lines.toString().padStart(4)} ${failure.path}`);
  }
  process.exit(1);
}

console.log(`[hotspot-loc] ok: all src files are under ${limit} lines`);
