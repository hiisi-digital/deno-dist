/**
 * How every test invokes this tool as a subprocess.
 *
 * One place, because there are five callers and they must agree.
 *
 * No config is passed. A child started by file path reads the manifest beside
 * that file, which is this package's own, and the `links` block there is what
 * resolves siblings that are not on a registry yet. `subprocess_config_test.ts`
 * is what holds that true.
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
