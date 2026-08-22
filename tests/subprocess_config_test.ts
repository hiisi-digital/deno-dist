/**
 * A child process resolves this package's own dependencies without being told.
 *
 * `tests/_cli.ts` used to pass `-c` to every child, on the reasoning that a
 * subprocess does not inherit the parent's config. That is true and it is
 * beside the point: a deno program started by file path reads the manifest
 * beside that file. Which manifest that is decides whether an unpublished
 * sibling resolves at all, and the whole five-caller subprocess suite depends
 * on the answer.
 *
 * That was established by deleting the config and watching the callers stay
 * green, which is a hand check that leaves no record. This is the record.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

import { cliArgs } from "./_cli.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test("the child is given a file path and no config", () => {
  const args = cliArgs("--version");

  assertEquals(args[0], "run");
  assert(
    !args.includes("-c") && !args.includes("--config"),
    `the helper passes a config again: ${args.join(" ")}`,
  );
  const cli = args.find((a) => a.endsWith("cli.ts"));
  assert(cli !== undefined, "no cli path in the arguments");
  assert(cli.startsWith("/"), `the cli must be an absolute path, got ${cli}`);
});

Deno.test("a child started that way resolves this package's unpublished siblings", async () => {
  // the law the helper's comment asserts. It runs the real CLI the real way and
  // asks only that it got far enough to answer, because getting that far means
  // every import in the graph resolved, `@hiisi/shimp` included.
  const { success, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: cliArgs("--version"),
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();

  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  assert(success, `the child could not run:\n${err}`);
  assertStringIncludes(out.trim(), ".", "no version came back");
});

Deno.test("the same child run from elsewhere still resolves", async () => {
  // the case that makes the file-path claim load-bearing rather than incidental:
  // the working directory is a temporary one with no manifest in it or above it
  // that could be doing the resolving instead.
  const elsewhere = await Deno.makeTempDir({ prefix: "deno_dist_cwd_" });
  try {
    const { success, stderr } = await new Deno.Command(Deno.execPath(), {
      args: cliArgs("--version"),
      cwd: elsewhere,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assert(
      success,
      "a child run from a directory with no manifest failed, so it was the " +
        `working directory resolving and not the config beside the program:\n${
          new TextDecoder().decode(stderr)
        }`,
    );
  } finally {
    await Deno.remove(elsewhere, { recursive: true });
  }
});
