/**
 * A package whose sources use decorators builds, and its metadata survives.
 *
 * dnt takes a small named subset of tsconfig and this tool used to hand it a
 * hardcoded `lib` and nothing else, so whatever the source config declared was
 * dropped on the way in. A package that compiles under deno, which enables
 * decorators by config, failed under dnt, which was never told.
 *
 * Two halves, failing differently. `experimentalDecorators` missing is a type
 * error on every decorated declaration, which at least stops the build.
 * `emitDecoratorMetadata` missing is silent: the code compiles and the
 * design-time type a framework reflects on is simply not there, so the framework
 * reads `undefined` and guesses. The second is why this asserts the metadata's
 * contents rather than that the build succeeded.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { cliArgs } from "./_cli.ts";

import {
  DENO_ONLY_COMPILER_OPTIONS,
  DNT_COMPILER_OPTIONS,
  dntCompilerOptions,
} from "../src/plugins/utils.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "decorated");

interface Ran {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cmd: string, args: readonly string[], cwd: string): Promise<Ran> {
  const { success, stdout, stderr } = await new Deno.Command(cmd, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return { success, stdout: d.decode(stdout), stderr: d.decode(stderr) };
}

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "target") continue;
      await copyTree(src, dest);
    } else await Deno.copyFile(src, dest);
  }
}

Deno.test("the forwarded set is exactly dnt's own, plus the one that is not in it", () => {
  // Pinned by name rather than sampled. An earlier version of this test asserted
  // that `noUncheckedIndexedAccess` is dropped, on the stated grounds that "dnt
  // rejects what it does not know". Both halves were false: the option is in
  // dnt 0.43.2's `compilerOptions` type, and dnt rejects nothing, which a build
  // carrying `totallyNotARealTsOption: 42` demonstrated by succeeding. The test
  // was pinning a defect as intended behaviour, which is the shape that survives
  // review and gets cited later.
  assertEquals([...DNT_COMPILER_OPTIONS].sort(), [
    "emitDecoratorMetadata",
    "experimentalDecorators",
    "importHelpers",
    "inlineSources",
    "lib",
    "noImplicitAny",
    "noImplicitReturns",
    "noImplicitThis",
    "noStrictGenericChecks",
    "noUncheckedIndexedAccess",
    "skipLibCheck",
    "sourceMap",
    "strictBindCallApply",
    "strictFunctionTypes",
    "strictNullChecks",
    "strictPropertyInitialization",
    "stripInternal",
    "target",
    "useUnknownInCatchVariables",
  ]);
});

Deno.test("every option dnt accepts is carried, including the ones nothing here uses", () => {
  // A library carries what it exposes for others, so the test is over the whole
  // set rather than over the two this repo happens to need.
  const declared: Record<string, unknown> = {};
  for (const key of DNT_COMPILER_OPTIONS) declared[key] = key === "lib" ? ["ES2023"] : true;
  const picked = dntCompilerOptions({ compilerOptions: declared });
  for (const key of DNT_COMPILER_OPTIONS) {
    assert(picked[key] !== undefined, `${key} was declared and did not come through`);
  }
});

Deno.test("a deno-only option is left behind, and says why", () => {
  // The reason the filter exists at all. These are meaningful where they were
  // written and wrong in a node build; dnt would accept them and TypeScript
  // would act on them.
  const declared: Record<string, unknown> = {};
  for (const key of Object.keys(DENO_ONLY_COMPILER_OPTIONS)) declared[key] = ["npm:@types/bun"];
  const picked = dntCompilerOptions({ compilerOptions: declared });
  for (const [key, why] of Object.entries(DENO_ONLY_COMPILER_OPTIONS)) {
    assertEquals(picked[key], undefined, `${key} should not be forwarded: ${why}`);
  }
  // and the two sets do not overlap, which is what makes both lists readable as
  // one decision rather than two that might disagree
  for (const key of Object.keys(DENO_ONLY_COMPILER_OPTIONS)) {
    assert(!DNT_COMPILER_OPTIONS.includes(key), `${key} is in both lists`);
  }
});

Deno.test("a config that names its own lib wins over the default", () => {
  assertEquals(dntCompilerOptions({})["lib"], ["ES2022", "DOM"]);
  assertEquals(
    dntCompilerOptions({ compilerOptions: { lib: ["ES2023"] } })["lib"],
    ["ES2023"],
  );
});

Deno.test("a decorated package builds and its metadata reaches a node consumer", async (t) => {
  const work = await Deno.makeTempDir({ prefix: "deno_dist_decorated_" });
  const project = join(work, "decorated");
  try {
    await copyTree(FIXTURE_DIR, project);

    await t.step("it builds for node", async () => {
      const result = await run(Deno.execPath(), cliArgs("build", "node"), project);
      assert(result.success, `build failed:\n${result.stdout}${result.stderr}`);
    });

    await t.step("the design-time types the compiler emitted are in the output", async () => {
      const consumer = join(work, "consumer");
      await Deno.mkdir(consumer);
      await Deno.writeTextFile(
        join(consumer, "package.json"),
        JSON.stringify({ name: "consumer", private: true, type: "module" }),
      );
      await Deno.writeTextFile(
        join(consumer, "app.mjs"),
        `import { fieldsOf, Greeting } from "@hiisi/decorated-fixture";\n` +
          `console.log(JSON.stringify(fieldsOf(Greeting)));\n`,
      );
      const install = await run(
        "npm",
        ["install", "--no-audit", "--no-fund", `file:${join(project, "target", "node")}`],
        consumer,
      );
      assert(install.success, `npm install failed:\n${install.stderr}`);

      const ran = await run("node", ["app.mjs"], consumer);
      assert(ran.success, `node app.mjs failed:\n${ran.stderr}`);
      // The values are the point. Without `emitDecoratorMetadata` this builds,
      // runs, and reports "unknown" for all three.
      assertEquals(
        JSON.parse(ran.stdout.trim()),
        { name: "String", times: "Number", loud: "Boolean" },
      );
    });
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});
