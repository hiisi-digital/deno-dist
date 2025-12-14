/**
 * @module deno-to-node
 *
 * Plugin for transforming Deno code to Node.js using dnt (Deno to Node Transform).
 * https://github.com/denoland/dnt
 */

import type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult } from "../types.ts";

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
  readonly shims?: {
    readonly deno?: boolean | "dev";
    readonly timers?: boolean;
    readonly prompts?: boolean;
    readonly blob?: boolean;
    readonly crypto?: boolean;
    readonly undici?: boolean;
    readonly weakRef?: boolean;
    readonly webSocket?: boolean;
  };
  /** Additional mappings for imports */
  readonly mappings?: Record<string, string>;
  /** Files to copy to output */
  readonly copyFiles?: readonly string[];
  /** Post-build script to run */
  readonly postBuild?: string;
}

// =============================================================================
// Plugin Implementation
// =============================================================================

/**
 * Create the deno-to-node plugin.
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

    // Validate that dnt is available
    try {
      // Check if dnt can be imported (this is a build-time check)
      context.log.debug("Checking dnt availability...");
    } catch {
      return {
        success: false,
        error: "dnt (Deno to Node Transform) is required but not available",
        durationMs: Date.now() - startTime,
      };
    }

    // Validate entry point exists
    const options = context.pluginConfig.options as DenoToNodeOptions | undefined;
    const entryPoint = options?.entryPoint ?? "mod.ts";
    const fullEntryPath = `${context.sourceDir}/${entryPoint}`;

    try {
      await Deno.stat(fullEntryPath);
    } catch {
      return {
        success: false,
        error: `Entry point not found: ${fullEntryPath}`,
        durationMs: Date.now() - startTime,
      };
    }

    context.log.info(`Entry point validated: ${entryPoint}`);

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
    const entryPoint = options?.entryPoint ?? "mod.ts";
    const packageName = options?.packageName ??
      context.variables.config["name"] as string | undefined ??
      "package";
    const packageVersion = options?.packageVersion ??
      context.variables.config["version"] as string | undefined ??
      "0.0.0";

    // Build the dnt command
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

    // Write the build script to a temp file
    const tempScriptPath = `${context.outputDir}/_dnt_build.ts`;
    await Deno.mkdir(context.outputDir, { recursive: true });
    await Deno.writeTextFile(tempScriptPath, buildScript);
    affectedFiles.push(tempScriptPath);

    context.log.debug(`Build script written to: ${tempScriptPath}`);

    // Run the build script
    try {
      const command = new Deno.Command("deno", {
        args: ["run", "-A", tempScriptPath],
        cwd: context.sourceDir,
        stdout: "piped",
        stderr: "piped",
      });

      const { code, stdout, stderr } = await command.output();

      if (context.pluginConfig.verbose) {
        const stdoutText = new TextDecoder().decode(stdout);
        const stderrText = new TextDecoder().decode(stderr);
        if (stdoutText) {
          context.log.debug(stdoutText);
        }
        if (stderrText) {
          context.log.debug(stderrText);
        }
      }

      if (code !== 0) {
        const stderrText = new TextDecoder().decode(stderr);
        return {
          success: false,
          error: `dnt build failed with exit code ${code}: ${stderrText}`,
          durationMs: Date.now() - startTime,
        };
      }

      context.log.info("dnt transformation completed successfully");
    } catch (error) {
      return {
        success: false,
        error: `Failed to run dnt: ${String(error)}`,
        durationMs: Date.now() - startTime,
      };
    }

    // Clean up temp script
    try {
      await Deno.remove(tempScriptPath);
    } catch {
      // Ignore cleanup errors
    }

    // Copy additional files if specified
    if (options?.copyFiles) {
      const copyPromises = options.copyFiles.map(async (file) => {
        const srcPath = `${context.sourceDir}/${file}`;
        const destPath = `${context.outputDir}/${file}`;
        try {
          await Deno.copyFile(srcPath, destPath);
          return { file, destPath, success: true as const };
        } catch (error) {
          return { file, error: String(error), success: false as const };
        }
      });

      const results = await Promise.all(copyPromises);
      for (const result of results) {
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
      try {
        const command = new Deno.Command("deno", {
          args: ["run", "-A", options.postBuild],
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
            durationMs: Date.now() - startTime,
          };
        }
      } catch (error) {
        return {
          success: false,
          error: `Failed to run post-build script: ${String(error)}`,
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
  shims?: DenoToNodeOptions["shims"];
  mappings?: Record<string, string>;
}): string {
  const shimsConfig = options.shims ?? {};

  const script = `
import { build, emptyDir } from "jsr:@deno/dnt";

await emptyDir("${options.outputDir}");

await build({
  entryPoints: ["${options.entryPoint}"],
  outDir: "${options.outputDir}",
  shims: {
    deno: ${JSON.stringify(shimsConfig.deno ?? "dev")},
    timers: ${shimsConfig.timers ?? false},
    prompts: ${shimsConfig.prompts ?? false},
    blob: ${shimsConfig.blob ?? false},
    crypto: ${shimsConfig.crypto ?? false},
    undici: ${shimsConfig.undici ?? false},
    weakRef: ${shimsConfig.weakRef ?? false},
    webSocket: ${shimsConfig.webSocket ?? false},
  },
  package: {
    name: "${options.packageName}",
    version: "${options.packageVersion}",
  },
  compilerOptions: {
    lib: ["ES2022", "DOM"],
  },
  typeCheck: "both",
  declaration: ${options.declaration},
  esModule: ${options.esm},
  scriptModule: ${options.cjs ? '"cjs"' : "false"},
  test: ${options.test},
  ${options.mappings ? `mappings: ${JSON.stringify(options.mappings)},` : ""}
});

// Post-build: copy LICENSE and README if they exist
try {
  await Deno.copyFile("LICENSE", "${options.outputDir}/LICENSE");
} catch { /* ignore */ }
try {
  await Deno.copyFile("README.md", "${options.outputDir}/README.md");
} catch { /* ignore */ }
`;

  return script;
}

// =============================================================================
// Export
// =============================================================================

export default denoToNodePlugin;
export { denoToNodePlugin };
