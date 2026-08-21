/**
 * @module
 *
 * A built distribution declares and resolves its own dependencies.
 *
 * The defect this pins is invisible from the output directory: the files are all there, the
 * manifest looks complete, and the package fails on its first import because nothing says
 * where its dependency comes from. Deno resolves the specifier through an import map, and a
 * built package has none.
 *
 * jsr dependencies are the interesting half. They are installable from npm, but only from
 * jsr's own compatibility registry and only under the name it publishes them as, so the
 * distribution has to carry both the rewritten specifier and the `.npmrc` that points the
 * `@jsr` scope at that registry.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { deriveDependencies, importedSpecifiers, jsrToNpmName } from "../src/plugins/utils.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "dependent");
const CLI = join(REPO_ROOT, "src", "cli.ts");

Deno.test("a jsr name becomes the name jsr publishes it under on npm", () => {
  assertEquals(jsrToNpmName("@hiisi/onlywhen"), "@jsr/hiisi__onlywhen");
  assertEquals(jsrToNpmName("@std/path"), "@jsr/std__path");
  // Unscoped is not a jsr package, so there is nothing to translate rather than a case to
  // handle. Without this the function would invent a name for a malformed specifier.
  assertEquals(jsrToNpmName("onlywhen"), undefined);
});

Deno.test("each specifier kind becomes the dependency it implies", () => {
  const derived = deriveDependencies({
    "@hiisi/onlywhen": "jsr:@hiisi/onlywhen@^0.5.0",
    "chalk": "npm:chalk@^5.3.0",
    "./local.ts": "./src/local.ts",
    "no-range": "npm:no-range",
  });

  assertEquals(derived.mappings["@hiisi/onlywhen"], "@jsr/hiisi__onlywhen");
  assertEquals(derived.dependencies["@jsr/hiisi__onlywhen"], "^0.5.0");
  assertEquals(derived.mappings["chalk"], "chalk");
  assertEquals(derived.dependencies["chalk"], "^5.3.0");
  assertEquals(derived.dependencies["no-range"], "*");
  assert(derived.needsJsrRegistry);

  // A path is a file in the project. Declaring a dependency for it would install something
  // that shadows the file it was meant to be.
  assertEquals(derived.mappings["./local.ts"], undefined);
  assertEquals(Object.keys(derived.dependencies).length, 3);
});

Deno.test("an already-mapped specifier gets no dependency", () => {
  // The control on the skip. `@std/path` is rewritten to `node:path`, so nothing imports it
  // any more and a declared dependency would be an install of something unused. For
  // `@std/assert`, which is rewritten to `bun:test`, it would be an install of something
  // that does not exist on npm at all.
  const derived = deriveDependencies(
    { "@std/path": "jsr:@std/path@^1.0.0", "@hiisi/onlywhen": "jsr:@hiisi/onlywhen@^0.5.0" },
    { alreadyMapped: new Set(["@std/path"]) },
  );
  assertEquals(Object.keys(derived.dependencies), ["@jsr/hiisi__onlywhen"]);
  assertEquals(derived.mappings["@std/path"], undefined);
});

Deno.test("no jsr dependency means no jsr registry line", () => {
  // Without this, `needsJsrRegistry` could be a constant true and every test above passes.
  const derived = deriveDependencies({ "chalk": "npm:chalk@^5.3.0" });
  assert(!derived.needsJsrRegistry);
});

Deno.test("a built bun distribution installs and runs with its dependency", async (t) => {
  const work = await Deno.makeTempDir({ prefix: "deno_dist_dep_" });
  const project = join(work, "dependent");
  await copyTree(FIXTURE, project);

  await t.step("the CLI builds it", async () => {
    const { success, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", CLI, "build", "bun"],
      cwd: project,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(success, new TextDecoder().decode(stderr));
  });

  const out = join(project, "target", "bun");

  await t.step("the manifest declares the dependency under its npm name", async () => {
    const manifest = JSON.parse(await Deno.readTextFile(join(out, "package.json")));
    const dependencies = manifest.dependencies as Record<string, string>;
    assertEquals(dependencies["@jsr/hiisi__onlywhen"], "^0.5.0");
  });

  await t.step("an .npmrc points the @jsr scope at jsr's registry", async () => {
    const npmrc = await Deno.readTextFile(join(out, ".npmrc"));
    assertStringIncludes(npmrc, "@jsr:registry=https://npm.jsr.io");
  });

  await t.step("the source imports the rewritten specifier", async () => {
    const mod = await Deno.readTextFile(join(out, "mod.ts"));
    assertStringIncludes(mod, "@jsr/hiisi__onlywhen");
    assert(
      !mod.includes('"@hiisi/onlywhen"'),
      "the original specifier survived, so the package still cannot resolve it",
    );
  });

  await t.step("the package resolves its own dependency in place", async () => {
    // Inside the built directory first, because this is the narrower claim and the one that
    // is about the manifest: `bun install` here reads the generated package.json and the
    // generated .npmrc and nothing else.
    const install = await new Deno.Command("bun", {
      args: ["install"],
      cwd: out,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(install.success, new TextDecoder().decode(install.stderr));

    const run = await new Deno.Command("bun", {
      args: ["-e", 'import { whichRuntime } from "./mod.ts"; console.log(whichRuntime());'],
      cwd: out,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(run.success, new TextDecoder().decode(run.stderr));
    assertEquals(new TextDecoder().decode(run.stdout).trim(), "bun");
  });

  await t.step("a consumer installing the packed tarball gets the dependency too", async () => {
    // The wider claim, and the one that is about publishing. A tarball is byte for byte what
    // a registry serves, so installing one exercises the path a real consumer takes,
    // transitive dependencies included.
    //
    // A `file:` dependency pointing at the output directory is not the same thing and does
    // not work: bun links the directory rather than installing it, so the linked package's
    // own dependencies are never fetched. That is package-manager behaviour rather than a
    // defect in the output, and testing through it would report a failure the published
    // package does not have.
    await Deno.remove(join(out, "node_modules"), { recursive: true }).catch(() => {});
    const pack = await new Deno.Command("npm", {
      args: ["pack", "--silent"],
      cwd: out,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(pack.success, new TextDecoder().decode(pack.stderr));
    const tarball = new TextDecoder().decode(pack.stdout).trim().split("\n").at(-1);
    assert(tarball !== undefined && tarball.endsWith(".tgz"), `npm pack gave ${tarball}`);

    const consumer = join(work, "consumer");
    await Deno.mkdir(consumer);
    await Deno.writeTextFile(join(consumer, ".npmrc"), "@jsr:registry=https://npm.jsr.io\n");
    await Deno.writeTextFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", type: "module", dependencies: {} }),
    );

    const add = await new Deno.Command("bun", {
      args: ["add", join(out, tarball)],
      cwd: consumer,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(add.success, new TextDecoder().decode(add.stderr));

    const run = await new Deno.Command("bun", {
      args: [
        "-e",
        'import { whichRuntime } from "@hiisi/dependent-fixture"; console.log(whichRuntime());',
      ],
      cwd: consumer,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(run.success, new TextDecoder().decode(run.stderr));
    assertEquals(new TextDecoder().decode(run.stdout).trim(), "bun");
  });

  await Deno.remove(work, { recursive: true });
});

/** A directory copied recursively, so the build runs somewhere disposable. */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory) {
      await copyTree(source, destination);
    } else {
      await Deno.copyFile(source, destination);
    }
  }
}

Deno.test("only specifiers the shipped files import become dependencies", () => {
  // An import map is the whole project's and includes its tests, which are not shipped.
  // Declaring from it makes an install fetch something unused, and for a test-only jsr
  // package it makes the install fail outright: `@std/assert` has no npm publication under
  // its own name, so `@jsr/std__assert` is a 404 and `bun install` refuses the whole package.
  const imports = {
    "@hiisi/onlywhen": "jsr:@hiisi/onlywhen@^0.5.0",
    "@std/assert": "jsr:@std/assert@^1.0.0",
    "@std/testing": "jsr:@std/testing@^1.0.0",
  };
  const used = new Set(["@hiisi/onlywhen"]);

  assertEquals(
    Object.keys(deriveDependencies(imports, { used }).dependencies),
    ["@jsr/hiisi__onlywhen"],
  );
  // The control: with no `used` set the old behaviour is what happens, so the test above is
  // about the filter rather than about the input happening to contain one entry.
  assertEquals(Object.keys(deriveDependencies(imports).dependencies).length, 3);
});

Deno.test("importedSpecifiers finds the bare ones and nothing else", () => {
  const found = importedSpecifiers([
    'import { a } from "@hiisi/onlywhen";',
    'import "./local.ts";',
    'import { b } from "node:fs";',
    'const c = await import("chalk");',
    'export { d } from "@scope/pkg/sub";',
    'import e from "pkg/deep/path";',
  ]);
  assert(found.has("@hiisi/onlywhen"));
  assert(found.has("chalk"));
  // A subpath import resolves through the package it names, so both forms are recorded and
  // an import map keyed on either matches.
  assert(found.has("@scope/pkg/sub"));
  assert(found.has("@scope/pkg"));
  assert(found.has("pkg"));
  // A path is not a dependency, and a protocol specifier resolves without one.
  assertFalse(found.has("./local.ts"));
  assertFalse(found.has("node:fs"));
});

Deno.test("a file importing nothing bare yields no specifiers", () => {
  // Without this, `importedSpecifiers` returning a fixed non-empty set satisfies every
  // assertion above.
  assertEquals(importedSpecifiers(['import "./a.ts";\nconst x = 1;']).size, 0);
  assertEquals(importedSpecifiers([]).size, 0);
});
