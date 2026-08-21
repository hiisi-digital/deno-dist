/**
 * The command. Deliberately carries no shebang, and guards on
 * `import.meta.main`.
 *
 * No shebang because one source builds three distributions and the first line
 * differs in each, so any line written here is wrong for at least two of them.
 * The build puts the correct one on each copy.
 *
 * `import.meta.main` because that is what a Deno command line tool is written
 * with, and because it is the construct that breaks in translation: dnt rewrites
 * it into a comparison that is false for every installed command. A fixture that
 * avoided it would leave that repair untested.
 *
 * @module
 */

import { greeting } from "./src/greet.ts";

/** Arguments, whichever runtime is asking. */
function args(): string[] {
  const g = globalThis as { Deno?: { args: string[] }; process?: { argv: string[] } };
  return g.Deno?.args ?? g.process?.argv.slice(2) ?? [];
}

function exit(code: number): void {
  const g = globalThis as {
    Deno?: { exit: (c: number) => never };
    process?: { exit: (c: number) => never };
  };
  (g.Deno?.exit ?? g.process?.exit)?.(code);
}

export function main(argv: readonly string[]): number {
  const who = argv[0];
  if (who === undefined) {
    console.log("usage: greet-fixture <name>");
    return 2;
  }
  console.log(greeting(who));
  return 0;
}

if (import.meta.main) {
  exit(main(args()));
}
