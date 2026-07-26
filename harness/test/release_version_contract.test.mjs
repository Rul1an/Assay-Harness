import { strict as assert } from "node:assert";
import { test } from "node:test";

import { assertReleaseVersion } from "../scripts/check-release-version.mjs";

test("release tag matches package and lockfile versions", () => {
  assert.doesNotThrow(() =>
    assertReleaseVersion("v0.10.2", "0.10.2", "0.10.2", "0.10.2")
  );
});

test("release tag mismatch fails closed", () => {
  assert.throws(
    () => assertReleaseVersion("v0.10.3", "0.10.2", "0.10.2", "0.10.2"),
    /release tag v0\.10\.3 does not match package version 0\.10\.2/
  );
});

test("lockfile top-level version mismatch fails closed", () => {
  assert.throws(
    () => assertReleaseVersion("v0.10.2", "0.10.2", "0.10.1", "0.10.2"),
    /lockfile top-level version 0\.10\.1 does not match package version 0\.10\.2/
  );
});

test("lockfile package-root version mismatch fails closed", () => {
  assert.throws(
    () => assertReleaseVersion("v0.10.2", "0.10.2", "0.10.2", "0.10.1"),
    /lockfile package-root version 0\.10\.1 does not match package version 0\.10\.2/
  );
});

test("non-stable release tags are rejected", () => {
  assert.throws(
    () =>
      assertReleaseVersion("v0.10.2-rc.1", "0.10.2", "0.10.2", "0.10.2"),
    /release tag must be a stable semantic version/
  );
});
