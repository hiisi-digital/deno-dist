/**
 * How every test invokes this tool as a subprocess.
 *
 * One place, because there are five callers and they must agree. The reason it
 * is not simply `["run", "-A", CLI]` is that this package depends on
 * `@hiisi/shimp`, which is not published yet: a child process started without
 * the local links config cannot resolve it and the build fails before it starts.
 * The tests run with `-c deno.local.json` themselves, and a subprocess does not
 * inherit that.
 *
 * The config is passed only when it is there, so this keeps working unchanged
 * once the dependency is published and the file goes away.
 *
 * @module
 */

import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const CLI = join(REPO_ROOT, "src", "cli.ts");
const LOCAL_CONFIG = join(REPO_ROOT, "deno.local.json");

function hasLocalConfig(): boolean {
  try {
    return Deno.statSync(LOCAL_CONFIG).isFile;
  } catch {
    return false;
  }
}

/** `deno run` arguments that reach this tool's CLI, with whatever it needs to resolve. */
export function cliArgs(...args: readonly string[]): string[] {
  const config = hasLocalConfig() ? ["-c", LOCAL_CONFIG] : [];
  return ["run", "-A", ...config, CLI, ...args];
}
