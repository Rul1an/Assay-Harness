/** Runner archive bounded tar/gzip readers and parsing helpers. */

import { readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/**
 * Maximum compressed archive size accepted by the validator. Larger files
 * are rejected with `ARCHIVE_TOO_LARGE` before any decompression work runs.
 * Real Runner archives are well under this bound (see proof packs in
 * `Rul1an/assay/docs/reference/runner/proof-packs/`).
 */
export const RUNNER_ARCHIVE_MAX_COMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MiB

/**
 * Maximum decompressed archive size accepted by the validator. Caps the
 * gunzip output to prevent zip-bomb-style memory exhaustion. Real Runner
 * archives are well under this bound.
 */
export const RUNNER_ARCHIVE_MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Parse a Runner manifest digest of the form `sha256:<64-hex>` into the
 * raw hex string. Returns `null` if the format is wrong.
 */
export function parseManifestDigest(value: string): string | null {
  if (!value.startsWith("sha256:")) return null;
  const hex = value.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return hex;
}

/**
 * Read a `.tar.gz` from disk and return a Map of in-archive path -> bytes.
 *
 * Only regular files (typeflag `0` or `\0`) are returned. Directories,
 * symlinks, and other entries are ignored. The reader handles standard
 * ustar headers; PAX/GNU long-name extensions are not supported because
 * Runner archives are produced with deterministic ustar mode and short
 * paths well below the 100-byte limit (see
 * `Rul1an/assay/crates/assay-runner-core/src/archive.rs`).
 *
 * Exported so the Tier-2B layer projection can read the same archive
 * without duplicating the size-limit guarded gunzip+tar pipeline. Read
 * path is identical to the one used by `validateRunnerArchive`.
 */
export function readRunnerArchiveFiles(filePath: string): Map<string, Buffer> {
  return readTarGz(filePath);
}

export function readTarGz(filePath: string): Map<string, Buffer> {
  const stat = statSync(filePath);
  if (stat.size > RUNNER_ARCHIVE_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `compressed archive size ${stat.size} bytes exceeds limit ${RUNNER_ARCHIVE_MAX_COMPRESSED_BYTES} bytes (ARCHIVE_TOO_LARGE)`,
    );
  }
  const compressed = readFileSync(filePath);
  // Node's gunzipSync accepts `maxOutputLength` as a hard cap. If the
  // decompressed stream exceeds the cap, gunzipSync throws synchronously
  // before allocating beyond the limit. This protects against zip-bomb-style
  // archives that gzip to a small size but expand catastrophically.
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(compressed, {
      maxOutputLength: RUNNER_ARCHIVE_MAX_DECOMPRESSED_BYTES,
    });
  } catch (err) {
    throw new Error(
      `gunzip failed (possibly DECOMPRESSED_TOO_LARGE; limit ${RUNNER_ARCHIVE_MAX_DECOMPRESSED_BYTES} bytes): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return parseTar(decompressed);
}

function parseTar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const BLOCK = 512;
  let offset = 0;

  while (offset + BLOCK <= buf.byteLength) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (isAllZero(header)) {
      // End-of-archive sentinel (two zero blocks per spec; one is enough to stop).
      break;
    }

    const name = readNullTerminated(header, 0, 100);
    const sizeField = readNullTerminated(header, 124, 12).trim();
    if (sizeField.length === 0) {
      throw new Error(`tar header at offset ${offset} has empty size field`);
    }
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`tar header at offset ${offset} has invalid size: ${sizeField}`);
    }
    const typeflagByte = header[156];
    const typeflag = typeflagByte === 0 ? "0" : String.fromCharCode(typeflagByte);

    offset += BLOCK;

    if (typeflag === "0" || typeflag === "\0") {
      if (offset + size > buf.byteLength) {
        throw new Error(`tar entry ${name} extends past end of buffer`);
      }
      const data = Buffer.from(buf.subarray(offset, offset + size));
      if (name.length > 0) {
        files.set(name, data);
      }
    }
    // Advance past the file body, padded to a block boundary.
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    offset += padded;
  }

  return files;
}

function readNullTerminated(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nullIdx = slice.indexOf(0);
  const end = nullIdx === -1 ? slice.byteLength : nullIdx;
  return slice.subarray(0, end).toString("utf8");
}

function isAllZero(buf: Buffer): boolean {
  for (let i = 0; i < buf.byteLength; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

export function safeJsonParse<T>(bytes: Buffer): T | null {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    return null;
  }
}
