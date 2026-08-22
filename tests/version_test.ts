/**
 * The reported version is the published one.
 *
 * `--version` printed `0.0.0` from every installed copy of this tool, because it
 * read `deno.json` off the filesystem beside the module and neither an `https:`
 * module nor a built distribution has one. The read failed, the `catch` returned
 * a default that looks like a real answer, and nothing said otherwise.
 *
 * The constant that replaced it can drift from the config, so this reads both
 * and compares. One line of duplication, checked.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

import { VERSION } from "../src/version.ts";
import { cliArgs } from "./_cli.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test("the constant the CLI reports matches the version the config publishes", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(join(REPO_ROOT, "deno.json")),
  ) as { version?: string };
  assertEquals(VERSION, config.version, "src/version.ts and deno.json disagree");
});

Deno.test("the CLI prints that version rather than a fallback", async () => {
  // The first version of this test asserted `VERSION !== "0.0.0"` and the
  // compiler rejected it: the constant has a literal type, so the comparison is
  // provably false and the assertion could never fail. It was a tautology
  // wearing a regression test's name. What it was reaching for is behavioural,
  // and this is that: run the thing and read what it says.
  const { success, stdout } = await new Deno.Command(Deno.execPath(), {
    args: cliArgs("--version"),
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(success, true);
  assertStringIncludes(new TextDecoder().decode(stdout), VERSION);
});
