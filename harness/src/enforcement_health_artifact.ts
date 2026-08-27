import { spawnSync } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";

export const MAX_ARTIFACT_ZIP_BYTES = 1 * 1024 * 1024;
export const MAX_CARRIER_FILE_BYTES = 64 * 1024;
export const MAX_PROVENANCE_FILE_BYTES = 64 * 1024;
export const MAX_ZIP_LIST_BYTES = 8 * 1024;
export const REQUIRED_ARTIFACT_ENTRIES = ["enforcement-health.json", "recipe.provenance.json"] as const;

export interface ArtifactIo {
  writeStream: (response: Response, dest: string, maxCompressedBytes: number) => Promise<number>;
  listEntries: (zipPath: string) => Promise<string[]>;
  extractEntry: (zipPath: string, name: string, maxBytes: number) => Promise<Buffer>;
}

function parseContentLength(raw: string | null): number {
  if (raw === null) {
    throw new Error("Content-Length missing");
  }
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error("Content-Length invalid");
  }
  return Number(raw);
}

export async function streamResponseToFile(
  response: Response,
  dest: string,
  maxCompressedBytes: number,
): Promise<number> {
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared > maxCompressedBytes) {
    throw new Error(`Content-Length ${declared} exceeds compressed cap ${maxCompressedBytes}`);
  }
  const body = response.body;
  if (!body) {
    throw new Error("artifact zip body missing");
  }
  const reader = body.getReader();
  const fd = openSync(dest, "w");
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxCompressedBytes) {
        throw new Error(`compressed stream over cap ${maxCompressedBytes}`);
      }
      if (total > declared) {
        throw new Error("compressed stream exceeds declared Content-Length");
      }
      writeSync(fd, value);
    }
  } finally {
    closeSync(fd);
    reader.releaseLock();
  }
  return total;
}

export function assertExactPromotionEntries(names: string[]): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    if (name.startsWith("/") || name.startsWith("\\")) {
      throw new Error(`absolute path: ${name}`);
    }
    if (name.includes("\0") || name.includes("/") || name.includes("\\")) {
      throw new Error(`unsafe separator in ${name}`);
    }
    if (name.includes("..")) {
      throw new Error(`traversal path: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate entry: ${name}`);
    }
    seen.add(name);
  }
  if (
    names.length !== REQUIRED_ARTIFACT_ENTRIES.length ||
    !REQUIRED_ARTIFACT_ENTRIES.every((entry) => seen.has(entry))
  ) {
    throw new Error(`exact two root entries required; extra or missing: ${names.join(",")}`);
  }
  return [...REQUIRED_ARTIFACT_ENTRIES];
}

export async function materializePromotionArtifacts(input: {
  response: Response;
  dest: string;
  io: ArtifactIo;
}): Promise<Record<(typeof REQUIRED_ARTIFACT_ENTRIES)[number], Buffer>> {
  await input.io.writeStream(input.response, input.dest, MAX_ARTIFACT_ZIP_BYTES);
  const names = assertExactPromotionEntries(await input.io.listEntries(input.dest));
  const carrier = await input.io.extractEntry(input.dest, names[0], MAX_CARRIER_FILE_BYTES);
  const provenance = await input.io.extractEntry(input.dest, names[1], MAX_PROVENANCE_FILE_BYTES);
  if (carrier.length > MAX_CARRIER_FILE_BYTES) {
    throw new Error("carrier exceeds expanded cap");
  }
  if (provenance.length > MAX_PROVENANCE_FILE_BYTES) {
    throw new Error("provenance exceeds expanded cap");
  }
  return {
    "enforcement-health.json": carrier,
    "recipe.provenance.json": provenance,
  };
}

export function productionZipIo(): ArtifactIo {
  return {
    writeStream: streamResponseToFile,
    async listEntries(zipPath) {
      const listed = spawnSync("unzip", ["-Z1", zipPath], {
        encoding: "utf8",
        maxBuffer: MAX_ZIP_LIST_BYTES,
      });
      if (listed.status !== 0) {
        throw new Error(listed.stderr || "zip list failed");
      }
      return listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    },
    async extractEntry(zipPath, name, maxBytes) {
      const extracted = spawnSync("unzip", ["-p", zipPath, name], {
        encoding: "buffer",
        maxBuffer: maxBytes,
      });
      if (extracted.status !== 0) {
        throw new Error(extracted.stderr?.toString() || `${name} exceeds expanded cap`);
      }
      const buf = Buffer.isBuffer(extracted.stdout) ? extracted.stdout : Buffer.from(extracted.stdout);
      if (buf.length > maxBytes) {
        throw new Error(`${name} exceeds expanded cap`);
      }
      return buf;
    },
  };
}
