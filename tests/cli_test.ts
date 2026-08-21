/**
 * Argument parsing, which had no tests and did not type-check.
 *
 * `src/cli.ts` is an entry point of its own in the `exports` map, and `deno check` was
 * pointed at `mod.ts` alone, which does not reach it. So `deno task all` passed while the
 * file carried two type errors, and no test imported it either. Both halves of that are
 * fixed: the check task names every export, and this exists.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { parseCliArgs } from "../src/cli.ts";

Deno.test("parseCliArgs", async (t) => {
  await t.step("takes the first positional as the command", () => {
    const args = parseCliArgs(["build", "node"]);
    assertEquals(args.command, "build");
    assertEquals(args.positional, ["node"]);
  });

  await t.step("falls back to help when given nothing", () => {
    assertEquals(parseCliArgs([]).command, "help");
  });

  await t.step("keeps every positional after the command", () => {
    const args = parseCliArgs(["build", "node", "bun", "deno"]);
    assertEquals(args.positional, ["node", "bun", "deno"]);
  });

  await t.step("boolean flags default to false rather than undefined", () => {
    // The flags are named one by one now, so an absent one is `false` and not a hole a
    // cast used to paper over.
    const { flags } = parseCliArgs(["build"]);
    assertEquals(flags.help, false);
    assertEquals(flags.version, false);
    assertEquals(flags.verbose, false);
    assertEquals(flags.clean, false);
    assertEquals(flags.all, false);
    assertEquals(flags.dryRun, false);
  });

  await t.step("boolean flags are set when given", () => {
    const { flags } = parseCliArgs(["build", "--verbose", "--clean", "--all"]);
    assertEquals(flags.verbose, true);
    assertEquals(flags.clean, true);
    assertEquals(flags.all, true);
  });

  await t.step("--dry-run is read as dryRun", () => {
    // The flag is spelled with a dash on the command line and without one in the type,
    // which is a rename the parser has to perform and nothing was checking.
    assertEquals(parseCliArgs(["build", "--dry-run"]).flags.dryRun, true);
    assertEquals(parseCliArgs(["build", "-n"]).flags.dryRun, true);
  });

  await t.step("short aliases mean the same as their long forms", () => {
    assertEquals(parseCliArgs(["-h"]).flags.help, true);
    assertEquals(parseCliArgs(["-v"]).flags.version, true);
  });

  await t.step("config defaults to deno.json and can be replaced", () => {
    assertEquals(parseCliArgs(["build"]).flags.config, "deno.json");
    assertEquals(
      parseCliArgs(["build", "--config", "other.jsonc"]).flags.config,
      "other.jsonc",
    );
  });

  await t.step("tag and notes are absent unless given", () => {
    // These two are what did not type-check. They are genuinely optional, and `undefined`
    // is not a member of `string | boolean`, which is what the flags used to be declared
    // as. `deno check` said so; nothing ran it against this file.
    const bare = parseCliArgs(["release"]);
    assertEquals(bare.flags.tag, undefined);
    assertEquals(bare.flags.notes, undefined);

    const given = parseCliArgs([
      "release",
      "--tag",
      "v1.2.3",
      "--notes",
      "NOTES.md",
    ]);
    assertEquals(given.flags.tag, "v1.2.3");
    assertEquals(given.flags.notes, "NOTES.md");
  });

  await t.step("scope is empty unless given", () => {
    assertEquals(parseCliArgs(["build"]).scope, {});
  });

  await t.step("scope reads key=value pairs separated by commas", () => {
    assertEquals(
      parseCliArgs(["build", "--scope", "env=prod,region=eu"]).scope,
      { env: "prod", region: "eu" },
    );
  });

  await t.step("a scope value may itself contain an equals sign", () => {
    // Splitting on every `=` rather than the first would lose the tail here, which is the
    // shape a base64 or a query string arrives in.
    assertEquals(
      parseCliArgs(["build", "--scope", "token=abc=def"]).scope,
      { token: "abc=def" },
    );
  });

  await t.step("a scope entry with no equals sign is skipped", () => {
    assertEquals(parseCliArgs(["build", "--scope", "novalue"]).scope, {});
  });
});
