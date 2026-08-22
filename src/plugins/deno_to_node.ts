/**
 * @module deno-to-node
 *
 * Plugin for transforming Deno code to Node.js using dnt (Deno to Node Transform).
 * https://github.com/denoland/dnt
 */

import type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult } from "../types.ts";
import {
  binOf,
  createTimer,
  DEFAULT_COPY_FILES,
  DEFAULT_ENTRY_POINT,
  dntCompilerOptions,
  ensureDirectory,
  entryPointsOf,
  failureResult,
  getPackageMetadata,
  getPackageName,
  getPackageVersion,
  makeRunnable,
  runDenoScript,
  selfImportsOf,
  SHEBANG,
  successResult,
  tryCopyFile,
} from "./utils.ts";
import type { EntryPoint } from "./utils.ts";

import { isNotFound, remove, stat, writeText } from "@hiisi/shimp";
// =============================================================================
// Plugin Metadata
// =============================================================================

const metadata: PluginMetadata = {
  id: "deno-to-node",
  name: "Deno to Node.js",
  version: "0.1.0",
  description: "Transform Deno code to Node.js using dnt",
  targetRuntime: "node",
  author: "Hiisi Digital",
  license: "MPL-2.0",
  repository: "https://github.com/hiisi-digital/deno-dist",
};

// =============================================================================
// Plugin Options
// =============================================================================

/**
 * Options for the deno-to-node plugin.
 */
export interface DenoToNodeOptions {
  /** Entry point file (default: "mod.ts") */
  readonly entryPoint?: string;
  /** Output directory within the dist output (default: ".") */
  readonly outDir?: string;
  /** Package name for package.json */
  readonly packageName?: string;
  /** Package version */
  readonly packageVersion?: string;
  /** Declaration emit, on dnt's own contract (default: "inline") */
  readonly declaration?: "inline" | "separate" | false;
  /** Whether to generate ESM output (default: true) */
  readonly esm?: boolean;
  /** Whether to generate CJS output (default: true) */
  readonly cjs?: boolean;
  /** Test file patterns to include */
  readonly testPattern?: string;
  /** Whether to run tests during build (default: false) */
  readonly test?: boolean;
  /** Shims to include */
  readonly shims?: DenoToNodeShims;
  /** Additional mappings for imports */
  readonly mappings?: Record<string, string>;
  /** Files to copy to output */
  readonly copyFiles?: readonly string[];
  /** Post-build script to run */
  readonly postBuild?: string;
}

/**
 * Shim configuration for dnt.
 */
export interface DenoToNodeShims {
  readonly deno?: boolean | "dev";
  readonly timers?: boolean;
  readonly prompts?: boolean;
  readonly blob?: boolean;
  readonly crypto?: boolean;
  readonly undici?: boolean;
  readonly weakRef?: boolean;
  readonly webSocket?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * The dnt this tool builds with.
 *
 * Pinned rather than bare, because a bare `jsr:@deno/dnt` resolves against the
 * lockfile of the project being built, which is not a thing this tool controls
 * and not a thing the person running it is thinking about. Two packages built by
 * the same command on the same machine came out different: one project's lock
 * held 0.41.3, whose translation of `import.meta.main` compares `import.meta.url`
 * against a raw `process.argv[1]` and is therefore false for every installed
 * command, and a project with no lock got 0.43.2, whose ponyfill is correct. The
 * first produced a command that ran, printed nothing and exited zero.
 *
 * So the build tool decides its own build tool's version. Raising this is a
 * deliberate act with a rebuild behind it, which is what a pin is for.
 */
export const DNT_VERSION = "0.43.2";

const DNT_BUILD_SCRIPT_NAME = "_dnt_build.ts";

// =============================================================================
// Plugin Implementation
// =============================================================================

/**
 * The deno-to-node plugin.
 */
const denoToNodePlugin: Plugin = {
  metadata,

  /**
   * Preprocess phase: Validate configuration and prepare environment.
   */
  async preprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const timer = createTimer();
    const warnings: string[] = [];

    context.log.info("Preparing Deno to Node.js transformation...");

    const options = context.pluginConfig.options as DenoToNodeOptions | undefined;
    const entryPoints = resolveEntryPoints(context, options);

    // Every entry point, not only the first. A package whose config declares `./cli` and
    // builds only `.` looks correct from the output directory, where the root export works,
    // and fails for a consumer importing the subpath.
    // All at once, because a stat is independent of every other one and a package with six
    // exports would otherwise pay six round trips to say the same thing.
    const checked = await Promise.all(entryPoints.map(async (entry) => {
      const fullEntryPath = `${context.sourceDir}/${entry.path}`;
      try {
        const info = await stat(fullEntryPath);
        return info.isFile ? undefined : `Entry point is not a file: ${fullEntryPath}`;
      } catch (error) {
        if (isNotFound(error)) {
          return `Entry point not found: ${fullEntryPath}`;
        }
        return `Failed to check entry point: ${String(error)}`;
      }
    }));

    const missing = checked.find((problem) => problem !== undefined);
    if (missing !== undefined) {
      return failureResult(missing, timer.elapsed());
    }

    context.log.info(
      `Entry points validated: ${entryPoints.map((e) => `${e.name} -> ${e.path}`).join(", ")}`,
    );

    // Warn about potential issues
    if (options?.test && !options?.testPattern) {
      warnings.push("Test is enabled but no testPattern specified - using default pattern");
    }

    return successResult({ durationMs: timer.elapsed(), warnings });
  },

  /**
   * Transform phase: Run dnt to convert Deno code to Node.js.
   */
  async transform(context: PluginContext): Promise<PluginPhaseResult> {
    const timer = createTimer();
    const affectedFiles: string[] = [];

    context.log.info("Transforming Deno code to Node.js using dnt...");

    const options = context.pluginConfig.options as DenoToNodeOptions | undefined;
    const entryPoints = resolveEntryPoints(context, options);

    // Resolve package name and version from options or config
    const packageName = options?.packageName ?? getPackageName(context);
    const packageVersion = options?.packageVersion ?? getPackageVersion(context);

    // dnt compiles, so a declared command has to point at what it emitted rather
    // than at the source the config named. Both module systems are emitted when
    // asked for, and the entry goes to the ES module one whenever it exists: dnt
    // drops a `{"type":"module"}` beside it, so node reads the file correctly
    // whichever way the surrounding package is declared.
    const compiledDir = (options?.esm ?? true) ? "esm" : "script";
    const bin = binOf(context.variables.config, (path) => compiledPath(path, compiledDir));

    // Build the dnt script
    const buildScript = generateBuildScript({
      sourceDir: context.sourceDir,
      outputDir: context.outputDir,
      entryPoints,
      packageName,
      packageVersion,
      packageMetadata: {
        ...getPackageMetadata(context),
        // The `#`-prefixed self-imports, which Node resolves through package.json `imports`.
        // dnt writes whatever the package block carries, so they travel that way rather than
        // through a rewrite, and the source keeps the names it was written with.
        ...(Object.keys(selfImportsOf(context.variables.config)).length > 0
          ? { imports: selfImportsOf(context.variables.config) }
          : {}),
        ...(Object.keys(bin).length > 0 ? { bin } : {}),
      },
      compilerOptions: dntCompilerOptions(context.variables.config),
      declaration: options?.declaration ?? "inline",
      esm: options?.esm ?? true,
      cjs: options?.cjs ?? true,
      test: options?.test ?? false,
      shims: options?.shims,
      mappings: options?.mappings,
    });

    // Ensure output directory exists
    await ensureDirectory(context.outputDir);

    // Write the build script to a temp file
    const tempScriptPath = `${context.outputDir}/${DNT_BUILD_SCRIPT_NAME}`;
    await writeText(tempScriptPath, buildScript);
    affectedFiles.push(tempScriptPath);

    context.log.debug(`Build script written to: ${tempScriptPath}`);

    // Run the build script
    const runResult = await runDenoScript(tempScriptPath, context.sourceDir);
    if (!runResult.success) {
      return failureResult(
        `dnt build failed: ${runResult.stderr ?? runResult.error}`,
        timer.elapsed(),
      );
    }

    if (context.pluginConfig.verbose && runResult.success) {
      if (runResult.stdout) context.log.debug(runResult.stdout);
      if (runResult.stderr) context.log.debug(runResult.stderr);
    }

    context.log.info("dnt transformation completed successfully");

    // Clean up temp script
    await cleanupTempScript(tempScriptPath);

    // npm's own documentation is blunt about the consequence of skipping this:
    // without the line "the scripts are started without the node executable".
    // dnt does not write one, so it is written here, onto the file the manifest
    // just claimed is a command.
    const runnable = await Promise.all(
      Object.entries(bin).map(async ([command, path]) => {
        const onDisk = `${context.outputDir}/${path.replace(/^\.\//, "")}`;
        try {
          await makeRunnable(onDisk, SHEBANG["node"] ?? "");
          return { path: onDisk, problem: null as string | null };
        } catch (error) {
          return {
            path: onDisk,
            problem: `bin "${command}" names ${path}, which dnt did not emit: ${String(error)}`,
          };
        }
      }),
    );
    const unbuilt = runnable.find((r) => r.problem !== null)?.problem;
    if (unbuilt !== undefined && unbuilt !== null) {
      return failureResult(unbuilt, timer.elapsed());
    }
    affectedFiles.push(...runnable.map((r) => r.path));

    // Copy additional files if specified
    const filesToCopy = options?.copyFiles ?? DEFAULT_COPY_FILES;
    const copyResults = await Promise.all(
      filesToCopy.map((file) =>
        tryCopyFile(`${context.sourceDir}/${file}`, `${context.outputDir}/${file}`, file)
      ),
    );

    for (const result of copyResults) {
      if (result.success) {
        affectedFiles.push(result.destPath);
        context.log.debug(`Copied: ${result.file}`);
      } else {
        context.log.warn(`Failed to copy ${result.file}: ${result.error}`);
      }
    }

    return successResult({ durationMs: timer.elapsed(), affectedFiles });
  },

  /**
   * Postprocess phase: Run any post-build scripts and cleanup.
   */
  async postprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const timer = createTimer();

    context.log.info("Running post-processing for Node.js output...");

    const options = context.pluginConfig.options as DenoToNodeOptions | undefined;

    // Run post-build script if specified
    if (options?.postBuild) {
      const result = await runDenoScript(options.postBuild, context.outputDir);
      if (!result.success) {
        return failureResult(
          `Post-build script failed: ${result.stderr ?? result.error}`,
          timer.elapsed(),
        );
      }
    }

    context.log.info("Post-processing completed");

    return successResult({ durationMs: timer.elapsed() });
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Clean up the temporary build script.
 */
async function cleanupTempScript(scriptPath: string): Promise<void> {
  try {
    await remove(scriptPath);
  } catch {
    // Ignore cleanup errors - not critical
  }
}

/**
 * Generate the dnt build script content.
 */
function generateBuildScript(options: {
  sourceDir: string;
  outputDir: string;
  entryPoints: readonly EntryPoint[];
  packageName: string;
  packageVersion: string;
  packageMetadata: Record<string, unknown>;
  declaration: "inline" | "separate" | false;
  esm: boolean;
  compilerOptions: Record<string, unknown>;
  cjs: boolean;
  test: boolean;
  shims?: DenoToNodeShims;
  mappings?: Record<string, string>;
}): string {
  const shims = options.shims ?? {};

  // Escape strings for safe embedding in JavaScript
  const safeEntryPoints = options.entryPoints
    .map((entry) => `{ name: ${escapeJsString(entry.name)}, path: ${escapeJsString(entry.path)} }`)
    .join(", ");
  const safeOutputDir = escapeJsString(options.outputDir);

  // dnt spreads this straight into the generated package.json, so everything
  // the registry wants rides along here: description, license, repository and
  // the rest, not only the name and version this block used to carry.
  const packageBlock = JSON.stringify(
    {
      name: options.packageName,
      version: options.packageVersion,
      ...options.packageMetadata,
    },
    null,
    2,
  ).replace(/\n/g, "\n  ");

  // Build shims configuration
  const shimsConfig = {
    deno: shims.deno ?? "dev",
    timers: shims.timers ?? false,
    prompts: shims.prompts ?? false,
    blob: shims.blob ?? false,
    crypto: shims.crypto ?? false,
    undici: shims.undici ?? false,
    weakRef: shims.weakRef ?? false,
    webSocket: shims.webSocket ?? false,
  };

  // Build mappings if provided
  const mappingsLine = options.mappings ? `  mappings: ${JSON.stringify(options.mappings)},` : "";

  return `// Auto-generated dnt build script
import { build, emptyDir } from "jsr:@deno/dnt@${DNT_VERSION}";

await emptyDir(${safeOutputDir});

await build({
  entryPoints: [${safeEntryPoints}],
  outDir: ${safeOutputDir},
  shims: {
    deno: ${JSON.stringify(shimsConfig.deno)},
    timers: ${shimsConfig.timers},
    prompts: ${shimsConfig.prompts},
    blob: ${shimsConfig.blob},
    crypto: ${shimsConfig.crypto},
    undici: ${shimsConfig.undici},
    weakRef: ${shimsConfig.weakRef},
    webSocket: ${shimsConfig.webSocket},
  },
  package: ${packageBlock},
  compilerOptions: ${JSON.stringify(options.compilerOptions)},
  typeCheck: "both",
  declaration: ${JSON.stringify(options.declaration)},
  esModule: ${options.esm},
  scriptModule: ${options.cjs ? '"cjs"' : "false"},
  test: ${options.test},
${mappingsLine}
});

// Post-build: copy LICENSE and README if they exist
const filesToCopy = ["LICENSE", "README.md"];
for (const file of filesToCopy) {
  try {
    await copyFile(file, ${safeOutputDir} + "/" + file);
  } catch {
    // File doesn't exist, skip
  }
}
`;
}

/**
 * Where dnt puts the compiled form of a source file.
 *
 * The output mirrors the source tree under one directory per module system, so
 * `./src/cli.ts` becomes `./esm/src/cli.js`. Only the extension and the prefix
 * move; the path in between is the one the source was written with, which is
 * what makes the result predictable from the config alone.
 */
function compiledPath(sourcePath: string, dir: string): string {
  const bare = sourcePath.startsWith("./") ? sourcePath.slice(2) : sourcePath;
  return `./${dir}/${bare.replace(/\.[cm]?tsx?$/, ".js")}`;
}

/**
 * Escape a string for safe embedding in JavaScript.
 */
function escapeJsString(str: string): string {
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

// =============================================================================
// Export
// =============================================================================

export default denoToNodePlugin;
export { denoToNodePlugin };

/**
 * The entry points to build, from the plugin options or from the source config.
 *
 * An explicit `entryPoint` option still wins and still means one entry, because a consumer
 * who named one meant one. With no option, the config's `exports` decides, which is what
 * makes a package with subpath exports produce a distribution that has them.
 */
function resolveEntryPoints(
  context: PluginContext,
  options: DenoToNodeOptions | undefined,
): EntryPoint[] {
  if (options?.entryPoint !== undefined) {
    return [{ name: ".", path: options.entryPoint }];
  }
  return entryPointsOf(context.variables.config, DEFAULT_ENTRY_POINT);
}
