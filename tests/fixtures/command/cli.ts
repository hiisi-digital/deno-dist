/**
 * The command. Deliberately carries no shebang.
 *
 * One source builds three distributions and the first line differs in each, so
 * writing one here would be right for at most one of them and wrong for the
 * rest. The build puts the correct line on each copy.
 *
 * @module
 */

import { greeting } from "./src/greet.ts";

const who = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[2] ??
  (globalThis as { Deno?: { args: string[] } }).Deno?.args?.[0];

if (who === undefined) {
  console.log("usage: greet-fixture <name>");
  // Exiting non-zero through whichever of the two exit calls this runtime has.
  const runtime = globalThis as {
    process?: { exit: (code: number) => never };
    Deno?: { exit: (code: number) => never };
  };
  (runtime.process?.exit ?? runtime.Deno?.exit)?.(2);
} else {
  console.log(greeting(who));
}
