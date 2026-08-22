// deno-lint-ignore-file no-await-in-loop -- the loops here walk a handful of
// fixture directories one at a time, so a failure names the fixture it came from.
/**
 * Every fixture is a package a consumer could actually install.
 *
 * A fixture is built and installed by the tests around it, so a defect in one
 * reads as a defect in the tool. One shipped as a single line of literal `\n`
 * escapes, written by an `echo` without `-e`, and npm always includes the README
 * in a package, so the fixture's built distribution carried it.
 *
 * The checks are the ones a package has to pass to be worth building at all:
 * the manifest parses and names itself, the entry points it declares exist, and
 * its prose is prose.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const FIXTURES = join(dirname(fromFileUrl(import.meta.url)), "fixtures");

async function fixtureDirs(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(FIXTURES)) {
    if (entry.isDirectory) found.push(entry.name);
  }
  return found.sort();
}

Deno.test("every fixture's manifest parses and names itself", async () => {
  for (const name of await fixtureDirs()) {
    const config = JSON.parse(
      await Deno.readTextFile(join(FIXTURES, name, "deno.json")),
    ) as Record<string, unknown>;
    assert(typeof config["name"] === "string", `${name}: no name`);
    assert(typeof config["version"] === "string", `${name}: no version`);
  }
});

Deno.test("every path a fixture's manifest names exists", async () => {
  // the defect class the tool itself was fixed for, applied to the fixtures that
  // are supposed to prove it
  for (const name of await fixtureDirs()) {
    const dir = join(FIXTURES, name);
    const config = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as Record<
      string,
      unknown
    >;

    const declared: string[] = [];
    const exports = config["exports"];
    if (typeof exports === "string") declared.push(exports);
    else if (exports !== null && typeof exports === "object") {
      for (const path of Object.values(exports as Record<string, string>)) declared.push(path);
    }
    const bin = config["bin"];
    if (typeof bin === "string") declared.push(bin);
    else if (bin !== null && typeof bin === "object") {
      for (const path of Object.values(bin as Record<string, string>)) declared.push(path);
    }

    for (const path of declared) {
      const stat = await Deno.stat(join(dir, path)).catch(() => undefined);
      assert(stat?.isFile === true, `${name}: declares ${path}, which is not there`);
    }
  }
});

Deno.test("every fixture's readme is prose rather than escapes", async () => {
  for (const name of await fixtureDirs()) {
    const path = join(FIXTURES, name, "README.md");
    const text = await Deno.readTextFile(path).catch(() => undefined);
    if (text === undefined) continue;
    // The tell, and it is exact: a file written by an `echo` without `-e` holds
    // the two characters backslash and n where a line break belongs, and so has
    // almost no real line breaks.
    assertEquals(
      text.includes("\\n"),
      false,
      `${name}/README.md contains a literal backslash-n`,
    );
    assert(text.split("\n").length > 2, `${name}/README.md is one line`);
  }
});
