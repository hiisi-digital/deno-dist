/**
 * How every test invokes this tool as a subprocess.
 *
 * One place, because there are five callers and they must agree.
 *
 * It used to pass `-c deno.local.json` when that file existed, on the reasoning
 * that a child cannot resolve `@hiisi/shimp` without it and does not inherit
 * the parent's config. The first half was true and the second made it moot: a
 * child started by file path reads the config beside that file, which is this
 * package's own `deno.json`, and the `links` block there is what resolves the
 * unpublished sibling. Deleting the local manifest left all five callers green.
 *
 * @module
 */

import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const CLI = join(REPO_ROOT, "src", "cli.ts");

/** `deno run` arguments that reach this tool's CLI. */
export function cliArgs(...args: readonly string[]): string[] {
  return ["run", "-A", CLI, ...args];
}
