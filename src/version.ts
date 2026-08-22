/**
 * The version this build reports.
 *
 * A constant rather than a read of `deno.json`, because the CLI runs from three
 * places and only one of them has that file next to it. Installed from jsr the
 * module lives behind an `https:` URL, where a filesystem read is not a thing
 * that can happen; built into an npm or bun distribution the config is not
 * shipped at all. Both cases used to land in the same `catch` and report
 * `0.0.0`, so every installed copy claimed to be an unreleased one.
 *
 * The duplication is real and is pinned by a test that reads the config and
 * compares, so the two cannot drift apart without the suite saying so.
 *
 * @module
 */

/** The package version, kept equal to `deno.json` by `tests/version_test.ts`. */
export const VERSION = "0.5.0";
