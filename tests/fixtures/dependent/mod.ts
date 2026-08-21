/**
 * A fixture whose only job is to import something from another jsr package.
 *
 * A distribution that copies its imports through unchanged looks correct until it is
 * installed: nothing in the built package says where `@hiisi/onlywhen` comes from, so the
 * first import fails. That failure is what this fixture exists to reach.
 */

import { runtime } from "@hiisi/onlywhen";

/** The runtime this is executing on, according to a dependency rather than to this file. */
export function whichRuntime(): string {
  if (runtime.deno) return "deno";
  if (runtime.node) return "node";
  if (runtime.bun) return "bun";
  return "unknown";
}
