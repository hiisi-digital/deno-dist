/**
 * @module deno-to-node
 *
 * Plugin for transforming Deno code to Node.js using dnt (Deno to Node Transform).
 * https://github.com/denoland/dnt
 */

import type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult } from "../types.ts";
import { type CopyResult, ensureDirectory, tryCopyFile } from "./utils.ts";

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

const DEFAULT_ENTRY_POINT = "mod.ts";
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
    const startTime = Date.now();
    const warnings: string[] = [];

    context.log.info("Preparing Deno to Node.js transformation...");

    // Validate entry point exists
    const options = context.pluginConfig.options as DenoToNodeOptions | undefined;
    const entryPoint = options?.entryPoint ?? DEFAULT_ENTRY_POINT;
    const fullEntryPath = `${context.sourceDir}/${entryPoint}`;

    try {
      const stat = await Deno.stat(fullEntryPath);
      if (!stat.isFile) {
        return {
          success: false,
          error: `Entry point is not a file: ${fullEntryPath}`,
          durationMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {
          success: false,
          error: `Entry point not found: ${fullEntryPath}`,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: false,
        error: `Failed to check entry point: ${String(error)}`,
        durationMs: Date.now() - startTime,
      };
    }

    context.log.info(`Entry point validated: ${entryPoint}`);

    // Warn about potential issues
    if (options?.test && !options?.testPattern) {
      warnings.push("Test is enabled but no testPattern specified - using default pattern");
    }

    return {
      success: true,
      warnings: warnings.length > 0 ? warnings : undefined,
      durationMs: Date.now() - startTime,
    };
  },

  /**
   * Transform phase: Run dnt to convert Deno code to Node.js.
   */
  async transform(context: PluginContext): Promise<PluginPhaseResult> {
    const startTime = Date.now();
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
    const runResult = await runDntBuild(tempScriptPath, context);
    if (!runResult.success) {
      return {
        success: false,
        error: runResult.error,
        durationMs: Date.now() - startTime,
      };
    }

    context.log.info("dnt transformation completed successfully");

    // Clean up temp script
    await cleanupTempScript(tempScriptPath);

    // Copy additional files if specified
    if (options?.copyFiles && options.copyFiles.length > 0) {
      const copyResults = await copyAdditionalFiles(context, options.copyFiles);
      for (const result of copyResults) {
        if (result.success) {
          affectedFiles.push(result.destPath);
          context.log.debug(`Copied: ${result.file}`);
        } else {
          context.log.warn(`Failed to copy ${result.file}: ${result.error}`);
        }
      }
    }

    return {
      success: true,
      affectedFiles,
      durationMs: Date.now() - startTime,
    };
  },

  /**
   * Postprocess phase: Run any post-build scripts and cleanup.
   */
  async postprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const startTime = Date.now();

    context.log.info("Running post-processing for Node.js output...");

    const options = context.pluginConfig.options as DenoToNodeOptions | undefined;

    // Run post-build script if specified
    if (options?.postBuild) {
      const result = await runPostBuildScript(options.postBuild, context);
      if (!result.success) {
        return {
          success: false,
          error: result.error,
          durationMs: Date.now() - startTime,
        };
      }
    }

    context.log.info("Post-processing completed");

    return {
      success: true,
      durationMs: Date.now() - startTime,
    };
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
 * Run the dnt build script.
 */
async function runDntBuild(
  scriptPath: string,
  context: PluginContext,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const command = new Deno.Command("deno", {
      args: ["run", "-A", scriptPath],
      cwd: context.sourceDir,
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();
    const decoder = new TextDecoder();

    if (context.pluginConfig.verbose) {
      const stdoutText = decoder.decode(stdout);
      const stderrText = decoder.decode(stderr);
      if (stdoutText) {
        context.log.debug(stdoutText);
      }
      if (stderrText) {
        context.log.debug(stderrText);
      }
    }

    if (code !== 0) {
      const stderrText = decoder.decode(stderr);
      return {
        success: false,
        error: `dnt build failed with exit code ${code}: ${stderrText}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to run dnt: ${String(error)}`,
    };
  }
}

/**
 * Run a post-build script.
 */
async function runPostBuildScript(
  scriptPath: string,
  context: PluginContext,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const command = new Deno.Command("deno", {
      args: ["run", "-A", scriptPath],
      cwd: context.outputDir,
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stderr } = await command.output();

    if (code !== 0) {
      const stderrText = new TextDecoder().decode(stderr);
      return {
        success: false,
        error: `Post-build script failed: ${stderrText}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to run post-build script: ${String(error)}`,
    };
  }
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
 * Copy additional files to the output directory.
 */
function copyAdditionalFiles(
  context: PluginContext,
  files: readonly string[],
): Promise<CopyResult[]> {
  return Promise.all(
    files.map((file) =>
      tryCopyFile(
        `${context.sourceDir}/${file}`,
        `${context.outputDir}/${file}`,
        file,
      )
    ),
  );
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
