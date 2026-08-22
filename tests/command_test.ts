// deno-lint-ignore-file no-await-in-loop -- the loops here run one built
// command at a time, so a failure names the runtime that produced it.
/**
 * A package that ships a command line tool installs as a command.
 *
 * Every other distribution test here asks whether a package imports. That is
 * half of what a package can be, and the other half was never produced: no
 * generated manifest carried a `bin` entry and no built file carried a shebang,
 * so a tool built through this pipeline installed cleanly and left nothing on
 * the PATH. The gap was invisible from the output directory, which is why it
 * survived a suite that walks manifests for paths that exist.
 *
 * The load-bearing check is the last one, and it is deliberately the one a
 * consumer performs rather than one this repo can satisfy on its own terms.
 * Installing a dependency makes npm and bun write `node_modules/.bin/<command>`
 * from the manifest's `bin` map and then execute it through its own first line.
 * So running that path exercises both halves at once, and neither a manifest
 * entry pointing at nothing nor a file missing its shebang can pass it.
 *
 * The unit-level properties are asserted too, because a failure in the
 * end-to-end step alone says a command did not run and not which half broke.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

import { binOf, makeRunnable, SHEBANG } from "../src/plugins/utils.ts";
import { DNT_VERSION } from "../src/plugins/deno_to_node.ts";
import { cliArgs } from "./_cli.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "command");

interface RunResult {
  readonly success: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cmd: string, args: readonly string[], cwd: string): Promise<RunResult> {
  const { success, code, stdout, stderr } = await new Deno.Command(cmd, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { success, code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
}

function assertRan(result: RunResult, what: string): void {
  assert(
    result.success,
    `${what} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory) await copyTree(src, dest);
    else await Deno.copyFile(src, dest);
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
}

// =============================================================================
// What a declaration turns into
// =============================================================================

Deno.test("binOf reads the map form and puts each path where the build wrote it", () => {
  const map = binOf(
    { name: "@hiisi/thing", bin: { "thing-tool": "./cli.ts" } },
    (path) => `./esm/${path.slice(2).replace(/\.ts$/, ".js")}`,
  );
  assertEquals(map, { "thing-tool": "./esm/cli.js" });
});

Deno.test("binOf resolves the bare form to the unscoped package name", () => {
  // npm's own rule: a string `bin` installs a command named after the package,
  // and the scope is not part of a command anyone can type
  assertEquals(
    binOf({ name: "@hiisi/thing", bin: "./cli.ts" }, (p) => p),
    { thing: "./cli.ts" },
  );
  assertEquals(
    binOf({ name: "unscoped", bin: "./cli.ts" }, (p) => p),
    { unscoped: "./cli.ts" },
  );
});

Deno.test("binOf declares nothing when the config declares nothing", () => {
  // the library case, which is most packages, and must not grow a bin entry
  assertEquals(binOf({ name: "@hiisi/thing" }, (p) => p), {});
  assertEquals(binOf({ name: "@hiisi/thing", bin: {} }, (p) => p), {});
  // a malformed declaration contributes nothing rather than a broken entry
  assertEquals(binOf({ name: "@hiisi/thing", bin: { a: 7 } }, (p) => p), {});
  assertEquals(binOf({ bin: "./cli.ts" }, (p) => p), {});
});

Deno.test("makeRunnable replaces an existing first line rather than stacking one on it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno_dist_shebang_" });
  try {
    const path = join(dir, "cli.js");

    await Deno.writeTextFile(path, "console.log(1);\n");
    await makeRunnable(path, SHEBANG["node"] ?? "");
    assertEquals(await Deno.readTextFile(path), "#!/usr/bin/env node\nconsole.log(1);\n");

    // twice, because a rebuild over an existing output is the ordinary case and
    // two shebangs is a syntax error: the second reads as a private field
    await makeRunnable(path, SHEBANG["bun"] ?? "");
    assertEquals(await Deno.readTextFile(path), "#!/usr/bin/env bun\nconsole.log(1);\n");

    // a file that is only a shebang has no newline to cut at
    await Deno.writeTextFile(path, "#!/usr/bin/env node");
    await makeRunnable(path, SHEBANG["bun"] ?? "");
    assertEquals(await Deno.readTextFile(path), "#!/usr/bin/env bun\n");

    // and the bit, which the shebang is useless without: bun installs a `file:`
    // dependency by symlinking into the built tree, so whatever mode the build
    // left is the mode the command runs under
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(path)).mode ?? 0;
      assertEquals(mode & 0o111, 0o111, "the owner, group and other execute bits");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("makeRunnable refuses a path the build did not produce", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno_dist_shebang_" });
  try {
    // the plugins turn this into a build failure, because the alternative is a
    // manifest promising a command that is not there
    let threw = false;
    try {
      await makeRunnable(join(dir, "absent.js"), SHEBANG["node"] ?? "");
    } catch {
      threw = true;
    }
    assert(threw, "a missing bin target should not pass silently");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// =============================================================================
// What a consumer gets
// =============================================================================

Deno.test("a built command installs and runs as a command", async (t) => {
  const work = await Deno.makeTempDir({ prefix: "deno_dist_command_" });
  const project = join(work, "command");
  const targets = {
    node: join(project, "target", "node"),
    bun: join(project, "target", "bun"),
  };

  try {
    await copyTree(FIXTURE_DIR, project);

    await t.step("the CLI builds every distribution", async () => {
      assertRan(
        await run(Deno.execPath(), cliArgs("build", "--all"), project),
        "build --all",
      );
    });

    await t.step("the build pins its own dnt, whatever the project's lock says", async () => {
      // The fixture ships a lock pinning dnt 0.41.3, which is the situation a
      // real package here was in. A bare `jsr:@deno/dnt` resolves against that
      // lock, so the tool's output depended on a file the tool does not own, and
      // 0.41.3 translates `import.meta.main` into a comparison that is false for
      // every installed command: the command ran, printed nothing, exited zero.
      const manifest = await readJson(join(targets.node, "package.json"));
      assertEquals(manifest["_generatedBy"], `dnt@${DNT_VERSION}`);
    });

    await t.step("each manifest declares the command", async () => {
      // the path differs per distribution and that is the point: dnt compiles,
      // so node's entry is the emitted .js, and bun ships the source it runs
      assertEquals(
        (await readJson(join(targets.node, "package.json")))["bin"],
        { "greet-fixture": "./esm/cli.js" },
      );
      assertEquals(
        (await readJson(join(targets.bun, "package.json")))["bin"],
        { "greet-fixture": "./cli.ts" },
      );
    });

    await t.step("the file each manifest names starts with its runtime's shebang", async () => {
      const cases: readonly (readonly [string, string])[] = [
        [join(targets.node, "esm", "cli.js"), "#!/usr/bin/env node"],
        [join(targets.bun, "cli.ts"), "#!/usr/bin/env bun"],
      ];
      for (const [path, shebang] of cases) {
        const text = await Deno.readTextFile(path);
        assert(text.startsWith(`${shebang}\n`), `${path} does not start with ${shebang}`);
        // exactly one, and the source it was built from carried none
        assertEquals(text.split("\n").filter((l) => l.startsWith("#!")).length, 1);
      }
    });

    await t.step("the command runs from node_modules/.bin under node", async () => {
      const consumer = join(work, "node-consumer");
      await Deno.mkdir(consumer);
      await Deno.writeTextFile(
        join(consumer, "package.json"),
        JSON.stringify({ name: "consumer", private: true, type: "module" }),
      );
      assertRan(
        await run("npm", ["install", "--no-audit", "--no-fund", `file:${targets.node}`], consumer),
        "npm install",
      );
      const bin = join(consumer, "node_modules", ".bin", "greet-fixture");
      const result = await run(bin, ["world"], consumer);
      assertRan(result, "greet-fixture under node");
      assertEquals(result.stdout, "hello, world\n");
    });

    await t.step("the command runs from node_modules/.bin under bun", async () => {
      const consumer = join(work, "bun-consumer");
      await Deno.mkdir(consumer);
      await Deno.writeTextFile(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "consumer",
          private: true,
          dependencies: { "@hiisi/command-fixture": `file:${targets.bun}` },
        }),
      );
      assertRan(await run("bun", ["install"], consumer), "bun install");
      const bin = join(consumer, "node_modules", ".bin", "greet-fixture");
      const result = await run(bin, ["world"], consumer);
      assertRan(result, "greet-fixture under bun");
      assertEquals(result.stdout, "hello, world\n");
    });

    await t.step(
      "the installed command reports usage and exits non-zero with no argument",
      async () => {
        // a shebang that names the wrong runtime still runs and still prints; the
        // exit code is what says the program's own control flow was reached
        for (const runtime of ["node", "bun"]) {
          const bin = join(work, `${runtime}-consumer`, "node_modules", ".bin", "greet-fixture");
          const result = await run(bin, [], dirname(bin));
          assertEquals(result.code, 2, `${runtime}: expected exit 2`);
          assertStringIncludes(result.stdout, "usage:", runtime);
        }
      },
    );
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});
