import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

// List-only on origin/main d9f26cf2: pinned v5.4.0 x86_64 header ISIZE sum is
// 31683222 bytes (~30.215 MiB) across 4 entries (dir, README, LICENSE, assay).
// 32 MiB / 8 entries is the smallest honest fixed cap that still admits that layout.
export const MEASURED_PUBLISHED_ISIZE_SUM = 31_683_222;
export const MEASURED_PUBLISHED_ENTRY_COUNT = 4;
export const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
export const MAX_TAR_ENTRIES = 8;
export const MAX_LIST_TIMEOUT_MS = 30_000;

function parseOctal(bytes) {
  const text = bytes.toString("utf8").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid tar size field");
  return value;
}

function readNulString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function assertTarHeaderChecksum(header) {
  let sum = 0;
  for (let i = 0; i < header.length; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i];
  }
  if (parseOctal(header.subarray(148, 156)) !== sum) throw new Error("invalid tar header checksum");
}

class HeaderOnlyTarStream {
  constructor(stream) {
    this.iter = stream[Symbol.asyncIterator]();
    this.queue = Buffer.alloc(0);
    this.skipRemaining = 0;
  }

  async pull() {
    const next = await this.iter.next();
    if (next.done) return false;
    let chunk = next.value;
    if (this.skipRemaining > 0) {
      if (chunk.length <= this.skipRemaining) {
        this.skipRemaining -= chunk.length;
        return true;
      }
      chunk = chunk.subarray(this.skipRemaining);
      this.skipRemaining = 0;
    }
    this.queue = Buffer.concat([this.queue, chunk]);
    return true;
  }

  async readExact(count) {
    while (this.queue.length < count) {
      if (!(await this.pull())) throw new Error("unable to list asset: truncated tar");
    }
    const out = this.queue.subarray(0, count);
    this.queue = this.queue.subarray(count);
    return out;
  }

  async skip(count) {
    if (this.queue.length > 0) {
      const take = Math.min(count, this.queue.length);
      this.queue = this.queue.subarray(take);
      count -= take;
    }
    this.skipRemaining += count;
    while (this.skipRemaining > 0) {
      if (!(await this.pull())) throw new Error("unable to list asset: truncated tar");
    }
  }
}

export async function assertSafeTarEntries(assetPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? MAX_LIST_TIMEOUT_MS;
  const maxExpandedBytes = options.maxExpandedBytes ?? MAX_EXPANDED_BYTES;
  const maxEntries = options.maxEntries ?? MAX_TAR_ENTRIES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_LIST_TIMEOUT_MS) {
    throw new Error("timeout-ms cannot raise the fixed maximum ceiling");
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const raw = createReadStream(assetPath, { signal: ac.signal });
  const gunzip = createGunzip();
  raw.on("error", (error) => gunzip.destroy(error));
  raw.pipe(gunzip);
  const reader = new HeaderOnlyTarStream(gunzip);
  const seen = new Set();
  let entries = 0;
  let expanded = 0;
  try {
    for (;;) {
      if (ac.signal.aborted) throw new Error("listing timeout");
      const header = await reader.readExact(512);
      if (header.every((byte) => byte === 0)) {
        await reader.readExact(512);
        break;
      }
      assertTarHeaderChecksum(header);
      const prefix = readNulString(header.subarray(345, 500));
      const base = readNulString(header.subarray(0, 100));
      const name = prefix ? `${prefix}/${base}` : base;
      const type = String.fromCharCode(header[156] || 0);
      const size = parseOctal(header.subarray(124, 136));
      if (!name || name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")) {
        throw new Error(`unsafe tar entry: ${name || "<empty>"}`);
      }
      if (seen.has(name)) throw new Error(`duplicate tar entry: ${name}`);
      seen.add(name);
      entries += 1;
      if (entries > maxEntries) throw new Error(`too many tar entries for max-entries=${maxEntries}`);
      if (type === "1" || type === "h") throw new Error("hardlink tar entries are refused");
      if (type === "2" || type === "l") throw new Error("symlink tar entries are refused");
      if (type !== "0" && type !== "\0" && type !== "5") {
        throw new Error(`unexpected tar entry type: ${type}`);
      }
      if (expanded + size > maxExpandedBytes) {
        throw new Error(`expanded archive too large for max-expanded-bytes=${maxExpandedBytes}`);
      }
      expanded += size;
      const pad = (512 - (size % 512)) % 512;
      if (size + pad > 0) await reader.skip(size + pad);
    }
  } catch (error) {
    if (ac.signal.aborted || error?.name === "AbortError") throw new Error("listing timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    raw.destroy();
    gunzip.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const asset = process.argv[2];
  const timeoutMs = Number(process.argv[3] ?? MAX_LIST_TIMEOUT_MS);
  assertSafeTarEntries(asset, { timeoutMs }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(3);
  });
}
