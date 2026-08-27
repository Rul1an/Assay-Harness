import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { after, test } from "node:test";
import {
  executeLocalProducer,
} from "../scripts/probe-v54-enforcement-health.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/probe-v54-enforcement-health.mjs", import.meta.url));
const BOUNDS = fileURLToPath(new URL("../scripts/v54-tar-entry-bounds.mjs", import.meta.url));
const HARNESS_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const LAYOUT = "assay-v5.4.0-x86_64-unknown-linux-gnu";

// List-only measurement of the pinned published v5.4.0 x86_64 asset on
// origin/main d9f26cf2 (sha256:352cd390dc59fb5adacecae5adf51976419f18ae50918f8f1504952869e94ad3):
// 4 entries, header ISIZE sum 31683222 (~30.215 MiB). Fixed ceilings must stay
// above that layout: 32 MiB and 8 entries.
const MEASURED_PUBLISHED_ISIZE_SUM = 31_683_222;
const MEASURED_PUBLISHED_ENTRY_COUNT = 4;
const FIXED_MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const FIXED_MAX_TAR_ENTRIES = 8;
const OVER_CEILING_BYTES = FIXED_MAX_EXPANDED_BYTES + 1;

const ACTIVE_HEALTH = {
  schema: "assay.enforcement_health.v1",
  status: "active",
  mechanism: "landlock",
  scope: "tcp_connect_landlock_port",
  policy_semantics: "allowlist",
  enforcement_class: "strong",
  landlock: {
    abi: 4,
    handled_access_net: ["connect_tcp"],
    allowed_connect_tcp_ports: [443],
    no_new_privs_confirmed: true,
    restrict_self_confirmed: true,
  },
  probe: {
    kind: "real_block",
    transport: "ipv4",
    blocked_action: "tcp_connect",
    blocked_port: 4444,
    blocked_errno: "EACCES",
    listener_reached: false,
  },
};

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "v54-probe-bounds-"));

after(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

function tempDir() {
  return mkdtempSync(join(FIXTURE_ROOT, "case-"));
}

function octalField(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function ustarHeader({ name, size = 0, type = "0", linkname = "" }) {
  const buf = Buffer.alloc(512);
  Buffer.from(name).copy(buf, 0, 0, 100);
  buf.write("0000644\0", 100, 8);
  buf.write("0000000\0", 108, 8);
  buf.write("0000000\0", 116, 8);
  buf.write(octalField(size, 12), 124, 12);
  buf.write("00000000000\0", 136, 12);
  buf.write("        ", 148, 8);
  buf.write(type, 156, 1);
  if (linkname) Buffer.from(linkname).copy(buf, 157, 0, 100);
  buf.write("ustar\0", 257, 6);
  buf.write("00", 263, 2);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buf;
}

function writeTarGz(path, entries) {
  const parts = [];
  for (const entry of entries) {
    const size = entry.size ?? entry.data?.length ?? 0;
    parts.push(ustarHeader({ ...entry, size }));
    if (entry.type === "0" || entry.type === undefined) {
      const data = entry.data ?? Buffer.alloc(size);
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  writeFileSync(path, gzipSync(Buffer.concat(parts)));
}

function fakeAssay() {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const i = args.indexOf("--enforcement-health");
const out = i >= 0 ? args[i + 1] : null;
if (out) fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(ACTIVE_HEALTH))});
process.exit(0);
`;
}

function packPublishedLayout(dir) {
  const root = join(dir, "pack");
  mkdirSync(join(root, LAYOUT), { recursive: true });
  writeFileSync(join(root, LAYOUT, "README.md"), "readme\n");
  writeFileSync(join(root, LAYOUT, "LICENSE"), "license\n");
  const bin = join(root, LAYOUT, "assay");
  writeFileSync(bin, fakeAssay());
  chmodSync(bin, 0o755);
  const asset = join(dir, `${LAYOUT}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", asset, "-C", root, LAYOUT], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  return asset;
}

function withExtractLog(fn) {
  const dir = tempDir();
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const log = join(dir, "tar-invocations.log");
  writeFileSync(log, "");
  writeFileSync(
    join(binDir, "tar"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
for arg in "$@"; do
  case "$arg" in
    -x|-xzf|-xvf|-extract|--extract) printf 'EXTRACT\\n' >> ${JSON.stringify(log)} ;;
  esac
done
exec /usr/bin/tar "$@"
`,
  );
  chmodSync(join(binDir, "tar"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${binDir}:${previous}`;
  try {
    return fn(log);
  } finally {
    process.env.PATH = previous;
  }
}

function packedFiles() {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: HARNESS_ROOT,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout);
  return (report[0]?.files ?? []).map((file) => file.path);
}

test("fixed expanded and entry ceilings sit above the measured published layout", () => {
  assert.ok(
    FIXED_MAX_EXPANDED_BYTES > MEASURED_PUBLISHED_ISIZE_SUM,
    "32 MiB must remain above the measured 31683222-byte ISIZE sum",
  );
  assert.ok(
    FIXED_MAX_TAR_ENTRIES > MEASURED_PUBLISHED_ENTRY_COUNT,
    "8 entries must remain above the measured 4-entry published layout",
  );
});

test("high-ratio KiB archive is refused before extract writes the claimed size", () => {
  const dir = tempDir();
  const asset = join(dir, "bomb.tar.gz");
  writeTarGz(asset, [{ name: "bomb", size: OVER_CEILING_BYTES }]);
  assert.ok(readFileSync(asset).length < 64 * 1024, "archive must stay in the KiB class");
  withExtractLog((log) => {
    assert.throws(
      () => executeLocalProducer({ asset, out: join(dir, "out.json") }),
      /expanded|isize|too large|ceiling|max-expanded/i,
    );
    const logged = readFileSync(log, "utf8");
    assert.doesNotMatch(logged, /EXTRACT/);
  });
});

test("entry-count overflow is refused before extract", () => {
  const dir = tempDir();
  const asset = join(dir, "many.tar.gz");
  const entries = Array.from({ length: FIXED_MAX_TAR_ENTRIES + 1 }, (_, i) => ({
    name: `e${i}`,
    data: Buffer.alloc(0),
  }));
  writeTarGz(asset, entries);
  withExtractLog((log) => {
    assert.throws(
      () => executeLocalProducer({ asset, out: join(dir, "out.json") }),
      /entr(y|ies)|count|too many/i,
    );
    assert.doesNotMatch(readFileSync(log, "utf8"), /EXTRACT/);
  });
});

test("symlink and hardlink tar types are refused before extract", () => {
  const dir = tempDir();
  for (const [type, label] of [["2", "symlink"], ["l", "symlink"], ["1", "hardlink"], ["h", "hardlink"]]) {
    const asset = join(dir, `${label}-${type}.tar.gz`);
    writeTarGz(asset, [{ name: "link", type, linkname: "target", size: 0 }]);
    withExtractLog((log) => {
      assert.throws(
        () => executeLocalProducer({ asset, out: join(dir, "out.json") }),
        /symlink|hardlink|link type|unsafe/i,
        label,
      );
      assert.doesNotMatch(readFileSync(log, "utf8"), /EXTRACT/, label);
    });
  }
});

test("package-path deep import of the probe script is not packed or exported", () => {
  const files = packedFiles();
  assert.equal(
    files.includes("scripts/probe-v54-enforcement-health.mjs"),
    false,
    "npm pack inventory must omit the probe script",
  );
  const pkg = JSON.parse(readFileSync(join(HARNESS_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.main, "dist/cli.js");
  assert.equal(pkg.bin?.["assay-harness"], "dist/cli.js");
  const exportsMap = pkg.exports;
  assert.equal(typeof exportsMap, "object");
  const exported = exportsMap["."] ?? exportsMap;
  const exportedPath = typeof exported === "string" ? exported : exported.default ?? exported.import;
  assert.match(String(exportedPath), /dist\/cli\.js/);
  assert.equal(exportsMap["./scripts/probe-v54-enforcement-health.mjs"], undefined);
  assert.ok(Array.isArray(pkg.files));
  assert.ok(
    pkg.files.some((entry) => String(entry).includes("!scripts/probe-v54-enforcement-health.mjs")),
    "files allowlist must exclude the probe script; un-export alone is insufficient",
  );
});

test("pinned four-entry published layout still reaches the producer path", () => {
  const dir = tempDir();
  const asset = packPublishedLayout(dir);
  const listed = spawnSync("tar", ["-tzf", asset], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const names = listed.stdout.split("\n").filter(Boolean);
  assert.ok(names.length <= 8 && names.length >= 4, names.join(","));
  const out = join(dir, "enforcement-health.json");
  const argv = executeLocalProducer({ asset, out });
  assert.ok(existsSync(out));
  assert.equal(argv.at(-1), "true");
});

test("no-op control: relative checkout import of the probe script still works", () => {
  assert.ok(existsSync(SCRIPT));
  const dir = tempDir();
  const asset = packPublishedLayout(dir);
  assert.doesNotThrow(() => executeLocalProducer({ asset, out: join(dir, "ok.json") }));
});

test("listing times out on a blocking asset without hanging the producer", { timeout: 3000 }, () => {
  const dir = tempDir();
  const fifo = join(dir, "block.tar.gz");
  const mkfifo = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  const started = Date.now();
  assert.throws(
    () => executeLocalProducer({ asset: fifo, out: join(dir, "out.json"), timeoutMs: 400 }),
    /listing timeout|timeout|not a file|refused/i,
  );
  assert.ok(Date.now() - started < 2500, "listing timeout must fail closed before a hang");
});

test("extract spawn on the producer path is time-bounded", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("export function executeLocalProducer");
  assert.ok(start >= 0);
  const block = src.slice(start, src.indexOf("if (!existsSync(bin)", start));
  assert.match(block, /spawnSync\("tar", \["-xzf"/);
  assert.match(block, /timeout:\s*timeoutMs/);
});

test("listing helper refuses an argv path when fd 3 is omitted", () => {
  const dir = tempDir();
  const asset = packPublishedLayout(dir);
  const listed = spawnSync(process.execPath, [BOUNDS, asset, "30000"], { encoding: "utf8" });
  assert.notEqual(listed.status, 0, "argv path must not be enough to list; fd 3 is required");
  assert.match(listed.stderr, /fd 3|listing fd|path fallback|refused/i);
});

test("parent listing spawn opens a read-only fd and does not put the asset path on child argv", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("function assertSafeTarEntries");
  assert.ok(start >= 0, "assertSafeTarEntries must remain the one listing function");
  const block = src.slice(start, src.indexOf("export function parseExactlyOneJson"));
  assert.match(block, /openSync\(\s*assetPath\s*,/);
  assert.match(block, /stdio:/);
  assert.doesNotMatch(block, /\[TAR_BOUNDS,\s*assetPath/);
  const helper = readFileSync(BOUNDS, "utf8");
  assert.doesNotMatch(helper, /createReadStream\(\s*assetPath/);
  assert.doesNotMatch(helper, /createReadStream\(\s*process\.argv/);
  assert.match(helper, /fd:\s*3|LISTING_FD|fstatSync\(\s*3\s*\)/);
});
