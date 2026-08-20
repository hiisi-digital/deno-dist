/**
 * The README's TypeScript examples type-check.
 *
 * A fenced block is prose to every tool in this repo: the compiler never sees
 * it, the formatter never touches it, and nothing notices when the API it
 * demonstrates moves underneath it. Across this estate that is exactly how
 * examples went stale, including a package whose very first usage example
 * failed to compile.
 *
 * Each block is checked the way a reader would encounter it, with this repo's
 * own import map.
 *
 * A block may reference names it never defines: an illustrative snippet does
 * that on purpose, and demanding otherwise would push the readme toward
 * complete programs nobody wants to read. So TS2304 and TS2552, which are
 * exactly "you used a name that is not declared", do not fail this test.
 * Everything else does, because everything else is the readme being wrong
 * about the package.
 *
 * @module
 */

import { assertEquals } from "@std/assert";

interface Block {
  readonly line: number;
  readonly code: string;
}

/** Diagnostics meaning "undeclared name", which an illustrative snippet may have. */
const SNIPPET_CODES = new Set(["TS2304", "TS2552"]);

function typescriptBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const fence = /^```(typescript|ts|tsx)\n([\s\S]*?)^```/gm;
  for (const m of markdown.matchAll(fence)) {
    // Indexed access is checked under noUncheckedIndexedAccess in some of
    // these repos, and a capture group that matched is still typed optional.
    const code = m[2] ?? "";
    blocks.push({
      line: markdown.slice(0, m.index).split("\n").length,
      code,
    });
  }
  return blocks;
}

function hardErrors(output: string): string[] {
  // deno colourises, so an anchored match against the raw stream never fires
  // and every failure reads as a snippet. That defect made a whole audit pass
  // report zero errors over a corpus that had twenty-two.
  // The escape character has to go too. Stripping only the bracket part leaves
  // "\x1bTS2307", so an anchored ^ never matches and every error reads as a
  // snippet. That exact omission made this test pass over a readme carrying a
  // deliberately broken import.
  // deno-lint-ignore no-control-regex
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const codes = [...plain.matchAll(/^(TS\d+)\s*\[ERROR\]/gm)]
    .map((m) => m[1] ?? "")
    .filter((c) => c !== "");
  return codes.filter((c) => !SNIPPET_CODES.has(c));
}

Deno.test("every README typescript example type-checks", async () => {
  const markdown = await Deno.readTextFile(
    new URL("../README.md", import.meta.url),
  );
  const blocks = typescriptBlocks(markdown);

  // If the readme stops carrying examples this test has stopped testing
  // anything, and should say so rather than passing quietly.
  if (blocks.length === 0) throw new Error("no typescript blocks in README.md");

  const dir = await Deno.makeTempDir({
    dir: new URL(".", import.meta.url).pathname,
  });
  let broken: string[] = [];
  try {
    // Checked in parallel: the blocks are independent, and a serial loop pays
    // a compiler startup per example for nothing.
    const results = await Promise.all(blocks.map(async (block) => {
      const file = `${dir}/readme_L${block.line}.ts`;
      await Deno.writeTextFile(file, block.code);
      const { stderr, success } = await new Deno.Command(Deno.execPath(), {
        args: ["check", file],
        stderr: "piped",
        stdout: "null",
      }).output();
      if (success) return null;
      const codes = hardErrors(new TextDecoder().decode(stderr));
      if (codes.length === 0) return null;
      return `README.md:${block.line} -> ${[...new Set(codes)].join(", ")}`;
    }));
    broken = results.filter((r): r is string => r !== null).sort();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }

  assertEquals(
    broken,
    [],
    `README examples that do not compile:\n  ${broken.join("\n  ")}`,
  );
});
