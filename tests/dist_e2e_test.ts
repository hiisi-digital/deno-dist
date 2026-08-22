/**
 * The distributions this tool produces install and run, checked the way a
 * consumer would check them.
 *
 * Every other test in this repo exercises the periphery: the config parser,
 * the template engine, the graph, the argument parser. None of them ever ran
 * the pipeline or a plugin, which is how a green suite coexisted with a bun
 * distribution whose package.json pointed at `mod.js` and `mod.d.ts` while
 * the output directory carried only `.ts` files. `bun install` followed by an
 * import by package name failed on every package this tool ever built for
 * bun, and nothing here knew.
 *
 * So this file builds a fixture package for all three runtimes with the real
 * CLI and then does what a consumer does: installs the result and imports it
 * by package name, under the actual runtime. Importing by relative path is
 * exactly the shape that hid the defect, and it is not used for anything
 * load-bearing here.
 *
 * Three properties, each generalised from a defect found by hand:
 *
 * 1. A generated manifest names only files that exist in the output. The bun
 *    manifest failed this outright; the node manifest carries entries dnt
 *    wires up itself and is checked with the same walk.
 * 2. A generated manifest carries the metadata a registry requires when the
 *    source config already has it: description, license, repository. Both the
 *    bun and the node manifests dropped all of it.
 * 3. The build machinery does not leak into the artifact. The passthrough
 *    plugin shipped `dist` and `distDir` inside the published deno.json.
 *
 * Plus the one the fixture exists for: the same consumer program, run against
 * each runtime's distribution, prints byte-identical output.
 *
 * @module
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { cliArgs } from "./_cli.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "parity");

/**
 * The consumer program. One source text, run under node, bun and deno, each
 * against its own distribution. Integer inputs so the output depends on the
 * distribution and not on float formatting.
 */
const CONSUMER_PROGRAM = `import { greet, stats } from "@hiisi/parity-fixture";
console.log(greet("distribution"));
const s = stats([3, 1, 4, 1, 5, 9, 2, 6]);
console.log(s.count, s.sum, s.min, s.max, s.mean);
console.log(JSON.stringify(s));
`;

interface RunResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<RunResult> {
  const { success, stdout, stderr } = await new Deno.Command(cmd, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** Fail with the process output attached, because "false" alone helps nobody. */
function assertRan(result: RunResult, what: string): void {
  assert(
    result.success,
    `${what} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect every relative file path a manifest names: main, module, types, bin
 * values and every string leaf of the exports map, however deeply nested.
 */
function manifestPaths(manifest: Record<string, unknown>): string[] {
  const paths: string[] = [];
  // main, module and types are file paths by definition, "./" prefix or not
  for (const key of ["main", "module", "types"]) {
    const value = manifest[key];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  // exports and bin leaves mix paths with conditions; only "./" strings claim a file
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.startsWith("./")) paths.push(node);
    } else if (node !== null && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) {
        walk(value);
      }
    }
  };
  walk(manifest["exports"]);
  walk(manifest["bin"]);
  return paths;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
}

Deno.test("built distributions install, run and agree", async (t) => {
  // one project copy, one build of all three targets, shared by every step
  const work = await Deno.makeTempDir({ prefix: "deno_dist_e2e_" });
  const project = join(work, "parity");
  const targets = {
    node: join(project, "target", "node"),
    bun: join(project, "target", "bun"),
    bunBundled: join(project, "target", "bun-bundled"),
    deno: join(project, "target", "deno"),
  };
  const outputs: Record<string, string> = {};

  try {
    await copyTree(FIXTURE_DIR, project);

    await t.step("the CLI builds every distribution", async () => {
      const result = await run(
        Deno.execPath(),
        cliArgs("build", "--all"),
        project,
      );
      assertRan(result, "build --all");
      const found = await Promise.all(
        Object.values(targets).map(async (dir) => [dir, await exists(dir)] as const),
      );
      for (const [dir, ok] of found) {
        assert(ok, `missing output directory: ${dir}`);
      }
    });

    await t.step("every manifest names only files that exist", async () => {
      const manifests: Array<[string, string]> = [
        [targets.node, "package.json"],
        [targets.bun, "package.json"],
        [targets.bunBundled, "package.json"],
        [targets.deno, "deno.json"],
      ];
      const missing = (await Promise.all(manifests.map(async ([dir, file]) => {
        const manifest = await readJson(join(dir, file));
        const checks = await Promise.all(
          manifestPaths(manifest).map(async (rel) => [rel, await exists(join(dir, rel))] as const),
        );
        return checks
          .filter(([, ok]) => !ok)
          .map(([rel]) => `${join(dir, file)} names ${rel}, which does not exist`);
      }))).flat();
      assertEquals(missing, [], `manifests naming phantom files:\n  ${missing.join("\n  ")}`);
    });

    await t.step("manifests carry the metadata the source config has", async () => {
      const manifests = await Promise.all(
        [targets.node, targets.bun, targets.bunBundled].map(async (dir) =>
          [dir, await readJson(join(dir, "package.json"))] as const
        ),
      );
      for (const [dir, manifest] of manifests) {
        assertEquals(manifest["name"], "@hiisi/parity-fixture", dir);
        assertEquals(manifest["version"], "0.1.0", dir);
        assertEquals(
          manifest["description"],
          "Fixture package for the distribution end-to-end tests.",
          `description missing from ${dir}/package.json`,
        );
        assertEquals(
          manifest["license"],
          "MPL-2.0",
          `license missing from ${dir}/package.json`,
        );
        assertEquals(
          manifest["repository"],
          "https://github.com/hiisi-digital/deno-dist",
          `repository missing from ${dir}/package.json`,
        );
      }
    });

    await t.step("the deno artifact carries no build machinery", async () => {
      const manifest = await readJson(join(targets.deno, "deno.json"));
      assertFalse("dist" in manifest, "dist config leaked into the published deno.json");
      assertFalse("distDir" in manifest, "distDir leaked into the published deno.json");
      // the metadata the source had is still there
      assertEquals(manifest["name"], "@hiisi/parity-fixture");
      assertEquals(manifest["license"], "MPL-2.0");
    });

    await t.step("the deno distribution survives a publish dry run", async () => {
      const result = await run(
        Deno.execPath(),
        ["publish", "--dry-run", "--allow-dirty"],
        targets.deno,
      );
      assertRan(result, "deno publish --dry-run");
    });

    await t.step("the node distribution installs and imports by name", async () => {
      const consumer = join(work, "node-consumer");
      await Deno.mkdir(consumer);
      await Deno.writeTextFile(
        join(consumer, "package.json"),
        JSON.stringify({ name: "consumer", private: true, type: "module" }),
      );
      await Deno.writeTextFile(join(consumer, "main.ts"), CONSUMER_PROGRAM);
      // require() through the same manifest, because the exports map serves
      // both and dnt emits a separate script build for exactly this consumer
      await Deno.writeTextFile(
        join(consumer, "main.cjs"),
        `const { greet } = require("@hiisi/parity-fixture");\nconsole.log(greet("cjs"));\n`,
      );
      assertRan(
        await run("npm", ["install", "--no-audit", "--no-fund", `file:${targets.node}`], consumer),
        "npm install",
      );
      const esm = await run("node", ["main.ts"], consumer);
      assertRan(esm, "node main.ts");
      outputs["node"] = esm.stdout;
      const cjs = await run("node", ["main.cjs"], consumer);
      assertRan(cjs, "node main.cjs");
      assertEquals(cjs.stdout, "hello, cjs\n");
    });

    await t.step("the bun distribution installs and imports by name", async () => {
      outputs["bun"] = await installAndRunUnderBun(join(work, "bun-consumer"), targets.bun);
    });

    await t.step("the bundled bun distribution installs and imports by name", async () => {
      // the bundle arm rewrites the manifest entries to bun build's output,
      // which is a separate branch of the manifest generator and stays tested
      outputs["bunBundled"] = await installAndRunUnderBun(
        join(work, "bun-bundled-consumer"),
        targets.bunBundled,
      );
    });

    await t.step("the deno distribution resolves by name and runs", async () => {
      const consumer = join(work, "deno-consumer");
      await Deno.mkdir(consumer);
      // a local directory cannot be added by name the way a registry package
      // can, so the name is bound through the import map, which is the same
      // resolution step jsr performs for a published package
      await Deno.writeTextFile(
        join(consumer, "deno.json"),
        JSON.stringify({
          imports: { "@hiisi/parity-fixture": toFileUrl(join(targets.deno, "mod.ts")).href },
        }),
      );
      await Deno.writeTextFile(join(consumer, "main.ts"), CONSUMER_PROGRAM);
      const result = await run(Deno.execPath(), ["run", "main.ts"], consumer);
      assertRan(result, "deno run main.ts");
      outputs["deno"] = result.stdout;
    });

    await t.step("every runtime prints identical output", () => {
      assert(outputs["node"] !== undefined, "node output missing");
      assertEquals(outputs["bun"], outputs["node"], "bun disagrees with node");
      assertEquals(outputs["bunBundled"], outputs["node"], "bundled bun disagrees with node");
      assertEquals(outputs["deno"], outputs["node"], "deno disagrees with node");
    });
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});

/** Install a distribution as a file dependency and run the consumer under bun. */
async function installAndRunUnderBun(consumer: string, target: string): Promise<string> {
  await Deno.mkdir(consumer);
  await Deno.writeTextFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "consumer",
      private: true,
      dependencies: { "@hiisi/parity-fixture": `file:${target}` },
    }),
  );
  await Deno.writeTextFile(join(consumer, "main.ts"), CONSUMER_PROGRAM);
  assertRan(await run("bun", ["install"], consumer), `bun install of ${target}`);
  const result = await run("bun", ["main.ts"], consumer);
  assertRan(result, `bun main.ts against ${target}`);
  return result.stdout;
}

/** Recursive copy. @std/fs copy exists, but this avoids a new import surface. */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory) {
      await copyTree(src, dest);
    } else {
      await Deno.copyFile(src, dest);
    }
  }
}
