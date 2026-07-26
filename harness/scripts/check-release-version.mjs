import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

export function assertReleaseVersion(
  tag,
  packageVersion,
  lockTopLevelVersion,
  lockPackageRootVersion
) {
  if (!STABLE_TAG.test(tag)) {
    throw new Error(`release tag must be a stable semantic version; got ${tag}`);
  }
  if (tag !== `v${packageVersion}`) {
    throw new Error(
      `release tag ${tag} does not match package version ${packageVersion}`
    );
  }
  if (lockTopLevelVersion !== packageVersion) {
    throw new Error(
      `lockfile top-level version ${lockTopLevelVersion} does not match package version ${packageVersion}`
    );
  }
  if (lockPackageRootVersion !== packageVersion) {
    throw new Error(
      `lockfile package-root version ${lockPackageRootVersion} does not match package version ${packageVersion}`
    );
  }
}

export function checkReleaseVersion(tag) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8")
  );

  assertReleaseVersion(
    tag,
    packageJson.version,
    packageLock.version,
    packageLock.packages?.[""]?.version
  );
  process.stdout.write(`release version contract passed: ${tag}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    checkReleaseVersion(process.argv[2] ?? "");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
