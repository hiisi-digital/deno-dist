/**
 * @module deno-to-node
 *
 * Plugin for transforming Deno code to Node.js using dnt (Deno to Node Transform).
 * https://github.com/denoland/dnt
 */

import type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult } from "../types.ts";
import {
  createTimer,
  DEFAULT_COPY_FILES,
  DEFAULT_ENTRY_POINT,
  ensureDirectory,
  failureResult,
  runDenoScript,
  successResult,
  tryCopyFile,
} from "./utils.ts";

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
  /** Whether to include type declarations (default: true) */
  readonly declaration?: boolean;
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
    const entryPoint = options?.entryPoint ?? DEFAULT_ENTRY_POINT;
    const fullEntryPath = `${context.sourceDir}/${entryPoint}`;

    // Validate entry point exists
    try {
      const stat = await Deno.stat(fullEntryPath);
      if (!stat.isFile) {
        return failureResult(`Entry point is not a file: ${fullEntryPath}`, timer.elapsed());
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return failureResult(`Entry point not found: ${fullEntryPath}`, timer.elapsed());
      }
      return failureResult(`Failed to check entry point: ${String(error)}`, timer.elapsed());
    }

    context.log.info(`Entry point validated: ${entryPoint}`);

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
    const entryPoint = options?.entryPoint ?? DEFAULT_ENTRY_POINT;

    // Resolve package name and version from options or config
    const packageName = resolvePackageName(options, context);
    const packageVersion = resolvePackageVersion(options, context);

    // Build the dnt script
    const buildScript = generateBuildScript({
      sourceDir: context.sourceDir,
      outputDir: context.outputDir,
      entryPoint,
      packageName,
      packageVersion,
      declaration: options?.declaration ?? true,
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
    await Deno.writeTextFile(tempScriptPath, buildScript);
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
 * Resolve the package name from options or context.
 */
function resolvePackageName(
  options: DenoToNodeOptions | undefined,
  context: PluginContext,
): string {
  if (options?.packageName) {
    return options.packageName;
  }
  const configName = context.variables.config["name"];
  if (typeof configName === "string" && configName.length > 0) {
    return configName;
  }
  return "package";
}

/**
 * Resolve the package version from options or context.
 */
function resolvePackageVersion(
  options: DenoToNodeOptions | undefined,
  context: PluginContext,
): string {
  if (options?.packageVersion) {
    return options.packageVersion;
  }
  const configVersion = context.variables.config["version"];
  if (typeof configVersion === "string" && configVersion.length > 0) {
    return configVersion;
  }
  return "0.0.0";
}

/**
 * Clean up the temporary build script.
 */
async function cleanupTempScript(scriptPath: string): Promise<void> {
  try {
    await Deno.remove(scriptPath);
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
  entryPoint: string;
  packageName: string;
  packageVersion: string;
  declaration: boolean;
  esm: boolean;
  cjs: boolean;
  test: boolean;
  shims?: DenoToNodeShims;
  mappings?: Record<string, string>;
}): string {
  const shims = options.shims ?? {};

  // Escape strings for safe embedding in JavaScript
  const safeEntryPoint = escapeJsString(options.entryPoint);
  const safeOutputDir = escapeJsString(options.outputDir);
  const safePackageName = escapeJsString(options.packageName);
  const safePackageVersion = escapeJsString(options.packageVersion);

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
import { build, emptyDir } from "jsr:@deno/dnt";

await emptyDir(${safeOutputDir});

await build({
  entryPoints: [${safeEntryPoint}],
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
  package: {
    name: ${safePackageName},
    version: ${safePackageVersion},
  },
  compilerOptions: {
    lib: ["ES2022", "DOM"],
  },
  typeCheck: "both",
  declaration: ${options.declaration},
  esModule: ${options.esm},
  scriptModule: ${options.cjs ? '"cjs"' : "false"},
  test: ${options.test},
${mappingsLine}
});

// Post-build: copy LICENSE and README if they exist
const filesToCopy = ["LICENSE", "README.md"];
for (const file of filesToCopy) {
  try {
    await Deno.copyFile(file, ${safeOutputDir} + "/" + file);
  } catch {
    // File doesn't exist, skip
  }
}
`;
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
