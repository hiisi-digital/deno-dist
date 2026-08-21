/**
 * @module
 *
 * A distribution carries every export its source config declares.
 *
 * A package built from the first entry only is not the package. The root export works, the
 * output directory looks complete, and a consumer writing `import { cli } from "pkg/cli"`
 * gets a resolution failure. Nothing in the build reports it, because from the build's point
 * of view it produced exactly what it was asked for.
 */

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { entryPointsOf, npmExportsOf, selfImportsOf } from "../src/plugins/utils.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "subpaths");
const CLI = join(REPO_ROOT, "src", "cli.ts");

Deno.test("a string exports field is one entry named for the root", () => {
  assertEquals(entryPointsOf({ exports: "./mod.ts" }), [{ name: ".", path: "./mod.ts" }]);
});

Deno.test("a map becomes one entry per subpath, root first", () => {
  // Root first because dnt names the first entry "." whatever it was called, so an ordering
  // that puts a subpath there silently renames it to the root export.
  const entries = entryPointsOf({
    exports: { "./cli": "./src/cli.ts", ".": "./mod.ts", "./b": "./src/b.ts" },
  });
  assertEquals(entries[0], { name: ".", path: "./mod.ts" });
  assertEquals(entries.length, 3);
});

Deno.test("a non-javascript export is not an entry point", () => {
  // A JSON schema is reachable in Deno and is not something a bundler compiles. Treating it
  // as an entry point fails the build rather than dropping one export.
  const entries = entryPointsOf({ exports: { ".": "./mod.ts", "./schema": "./schema.json" } });
  assertEquals(entries.map((e) => e.name), ["."]);
});

Deno.test("a config declaring no exports falls back rather than producing nothing", () => {
  // The control on the fallback. Without it, an empty result reads the same as a config with
  // one export and the build silently produces an empty package.
  assertEquals(entryPointsOf({}), [{ name: ".", path: "./mod.ts" }]);
  assertEquals(entryPointsOf({ exports: {} }, "./main.ts"), [{ name: ".", path: "./main.ts" }]);
});

Deno.test("the npm exports map keeps every subpath", () => {
  const map = npmExportsOf([
    { name: ".", path: "./mod.ts" },
    { name: "./cli", path: "./src/cli.ts" },
  ]);
  assertEquals(Object.keys(map), [".", "./cli"]);
  assertEquals(map["./cli"], { types: "./src/cli.ts", default: "./src/cli.ts" });
});

Deno.test("both distributions carry the subpath, and it imports", async (t) => {
  const work = await Deno.makeTempDir({ prefix: "deno_dist_sub_" });
  const project = join(work, "subpaths");
  await copyTree(FIXTURE, project);

  await t.step("the CLI builds both", async () => {
    // Sequentially, deliberately. dnt writes its generated build script into the project
    // directory, so two builds of the same project at once are two writers of one path.
    await build("node");
    await build("bun");

    async function build(target: string): Promise<void> {
      const { success, stderr } = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", CLI, "build", target],
        cwd: project,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(success, `${target}: ${new TextDecoder().decode(stderr)}`);
    }
  });

  await t.step("the node manifest declares the subpath", async () => {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(project, "target", "node", "package.json")),
    );
    const exports = manifest.exports as Record<string, unknown>;
    assert("./cli" in exports, `node exports: ${JSON.stringify(Object.keys(exports))}`);
  });

  await t.step("the bun manifest declares the subpath", async () => {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(project, "target", "bun", "package.json")),
    );
    const exports = manifest.exports as Record<string, unknown>;
    assert("./cli" in exports, `bun exports: ${JSON.stringify(Object.keys(exports))}`);
  });

  await t.step("node imports the subpath by name", async () => {
    assertEquals(await importSubpath("node", join(project, "target", "node")), "cli");
  });

  await t.step("bun imports the subpath by name", async () => {
    assertEquals(await importSubpath("bun", join(project, "target", "bun")), "cli");
  });

  await Deno.remove(work, { recursive: true });
});

/** Installs a built distribution and imports its `./cli` subpath under `runtime`. */
async function importSubpath(runtime: string, distribution: string): Promise<string> {
  const consumer = await Deno.makeTempDir({ prefix: `consumer_${runtime}_` });
  await Deno.writeTextFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "consumer",
      type: "module",
      dependencies: { "@hiisi/subpaths-fixture": `file:${distribution}` },
    }),
  );
  const install = await new Deno.Command(runtime === "node" ? "npm" : "bun", {
    args: ["install"],
    cwd: consumer,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(install.success, new TextDecoder().decode(install.stderr));

  await Deno.writeTextFile(
    join(consumer, "run.mjs"),
    'import { cli } from "@hiisi/subpaths-fixture/cli";\nconsole.log(cli());\n',
  );
  const run = await new Deno.Command(runtime, {
    args: ["run.mjs"],
    cwd: consumer,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(run.success, `${runtime}: ${new TextDecoder().decode(run.stderr)}`);
  const answer = new TextDecoder().decode(run.stdout).trim();
  await Deno.remove(consumer, { recursive: true });
  return answer;
}

/** A directory copied recursively, so the build runs somewhere disposable. */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory) await copyTree(source, destination);
    else await Deno.copyFile(source, destination);
  }
}

Deno.test("self-imports come through, and only the ones npm can express", () => {
  const self = selfImportsOf({
    imports: {
      "#core": "./core/mod.ts",
      "#up": "../shared/mod.ts",
      "@std/fs": "jsr:@std/fs@^1.0.0",
      "#dep": "jsr:@scope/pkg@^1.0.0",
    },
  });
  assertEquals(self["#core"], "./core/mod.ts");
  assertEquals(self["#up"], "../shared/mod.ts");
  // A dependency is not a self-import even when it is spelled with a hash. Node requires the
  // target to be a relative path, so writing this one would ship a name that will not
  // resolve, which is the failure the whole function exists to prevent.
  assertEquals(self["#dep"], undefined);
  assertEquals(self["@std/fs"], undefined);
});

Deno.test("a config with no self-imports yields none", () => {
  // Without this, a function returning a fixed non-empty map satisfies the test above.
  assertEquals(Object.keys(selfImportsOf({ imports: { "@std/fs": "jsr:@std/fs@^1" } })).length, 0);
  assertEquals(Object.keys(selfImportsOf({})).length, 0);
});
