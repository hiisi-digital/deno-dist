/**
 * @module deno-to-bun
 *
 * Plugin for transforming Deno code to Bun.
 * Bun has high compatibility with Deno, so this plugin primarily handles
 * import remapping and Deno-specific API shims.
 */

import type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult } from "../types.ts";
import {
  collectFiles,
  type CopyResult,
  ensureDirectory,
  escapeRegex,
  getDirectory,
  getRelativePath,
  tryCopyFile,
} from "./utils.ts";

// =============================================================================
// Plugin Metadata
// =============================================================================

const metadata: PluginMetadata = {
  id: "deno-to-bun",
  name: "Deno to Bun",
  version: "0.1.0",
  description: "Transform Deno code to Bun runtime",
  targetRuntime: "bun",
  author: "Hiisi Digital",
  license: "MPL-2.0",
  repository: "https://github.com/hiisi-digital/deno-dist",
};

// =============================================================================
// Plugin Options
// =============================================================================

/**
 * Options for the deno-to-bun plugin.
 */
export interface DenoToBunOptions {
  /** Entry point file (default: "mod.ts") */
  readonly entryPoint?: string;
  /** Whether to bundle the output (default: false) */
  readonly bundle?: boolean;
  /** Whether to minify the output (default: false) */
  readonly minify?: boolean;
  /** Target environment (default: "bun") */
  readonly target?: "bun" | "browser" | "node";
  /** Source map generation (default: "external") */
  readonly sourcemap?: "none" | "inline" | "external";
  /** Additional mappings for imports */
  readonly mappings?: Record<string, string>;
  /** Files to copy to output */
  readonly copyFiles?: readonly string[];
  /** Whether to generate package.json (default: true) */
  readonly generatePackageJson?: boolean;
}

// =============================================================================
// Import Mappings
// =============================================================================

/**
 * Default import mappings from Deno to Bun/Node equivalents.
 */
const DEFAULT_MAPPINGS: Readonly<Record<string, string>> = {
  "jsr:@std/assert": "bun:test",
  "jsr:@std/path": "node:path",
  "jsr:@std/fs": "node:fs/promises",
};

// =============================================================================
// API Transformation Rules
// =============================================================================

/**
 * API transformation rule.
 */
interface ApiTransformRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Rules for transforming Deno APIs to Bun equivalents.
 * Using pre-compiled regexes for efficiency.
 */
const API_TRANSFORM_RULES: readonly ApiTransformRule[] = [
  // Deno.readTextFile -> Bun.file().text()
  {
    pattern: /Deno\.readTextFile\(([^)]+)\)/g,
    replacement: "await Bun.file($1).text()",
  },
  // Deno.writeTextFile -> Bun.write()
  {
    pattern: /Deno\.writeTextFile\(([^,]+),\s*([^)]+)\)/g,
    replacement: "await Bun.write($1, $2)",
  },
  // Deno.env.get -> Bun.env
  {
    pattern: /Deno\.env\.get\(([^)]+)\)/g,
    replacement: "Bun.env[$1]",
  },
  // Deno.cwd() -> process.cwd()
  {
    pattern: /Deno\.cwd\(\)/g,
    replacement: "process.cwd()",
  },
  // Deno.exit -> process.exit
  {
    pattern: /Deno\.exit\(/g,
    replacement: "process.exit(",
  },
  // Deno.args -> Bun.argv.slice(2)
  {
    pattern: /Deno\.args\b/g,
    replacement: "Bun.argv.slice(2)",
  },
];

// =============================================================================
// Plugin Implementation
// =============================================================================

/**
 * Create the deno-to-bun plugin.
 */
const denoToBunPlugin: Plugin = {
  metadata,

  /**
   * Preprocess phase: Validate configuration and prepare environment.
   */
  async preprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const startTime = Date.now();
    const warnings: string[] = [];

    context.log.info("Preparing Deno to Bun transformation...");

    // Validate entry point exists
    const options = context.pluginConfig.options as DenoToBunOptions | undefined;
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

    // Warn about Deno-specific APIs that may need manual handling
    try {
      const content = await Deno.readTextFile(fullEntryPath);
      if (content.includes("Deno.")) {
        warnings.push(
          "Source uses Deno.* APIs. Some may not be available in Bun.",
        );
      }
    } catch {
      // Ignore read errors during preprocess
    }

    return {
      success: true,
      warnings: warnings.length > 0 ? warnings : undefined,
      durationMs: Date.now() - startTime,
    };
  },

  /**
   * Transform phase: Copy and transform Deno code for Bun.
   */
  async transform(context: PluginContext): Promise<PluginPhaseResult> {
    const startTime = Date.now();
    const affectedFiles: string[] = [];

    context.log.info("Transforming Deno code for Bun runtime...");

    const options = context.pluginConfig.options as DenoToBunOptions | undefined;
    const mappings = { ...DEFAULT_MAPPINGS, ...options?.mappings };

    // Create output directory
    await ensureDirectory(context.outputDir);

    // Collect TypeScript files (excluding tests)
    const files = await collectFiles(context.sourceDir, {
      extensions: [".ts", ".tsx"],
      includeTests: false,
      includeAssets: false,
    });

    // Process all files in parallel
    const processedFiles = await Promise.all(
      files.map((file) => processFile(file, context, mappings)),
    );
    affectedFiles.push(...processedFiles);

    // Generate package.json if requested
    if (options?.generatePackageJson !== false) {
      const packageJson = generatePackageJson(context, options);
      const packageJsonPath = `${context.outputDir}/package.json`;
      await Deno.writeTextFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
      affectedFiles.push(packageJsonPath);
      context.log.debug("Generated package.json");
    }

    // Copy additional files if specified
    const filesToCopy = options?.copyFiles ?? ["LICENSE", "README.md"];
    const copyResults = await copyAdditionalFiles(context, filesToCopy);

    for (const result of copyResults) {
      if (result.success) {
        affectedFiles.push(result.destPath);
        context.log.debug(`Copied: ${result.file}`);
      }
    }

    context.log.info(`Transformation completed. ${affectedFiles.length} files affected.`);

    return {
      success: true,
      affectedFiles,
      durationMs: Date.now() - startTime,
    };
  },

  /**
   * Postprocess phase: Optional bundling and optimization.
   */
  async postprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const startTime = Date.now();

    const options = context.pluginConfig.options as DenoToBunOptions | undefined;

    // If bundling is not requested, skip
    if (!options?.bundle) {
      context.log.info("Skipping bundling (not enabled)");
      return {
        success: true,
        durationMs: Date.now() - startTime,
      };
    }

    context.log.info("Bundling output with Bun...");

    const entryPoint = options?.entryPoint ?? "mod.ts";
    const target = options?.target ?? "bun";
    const minify = options?.minify ?? false;
    const sourcemap = options?.sourcemap ?? "external";

    try {
      const args = buildBundleArgs(entryPoint, target, minify, sourcemap);

      const command = new Deno.Command("bun", {
        args,
        cwd: context.outputDir,
        stdout: "piped",
        stderr: "piped",
      });

      const { code, stderr } = await command.output();

      if (code !== 0) {
        const stderrText = new TextDecoder().decode(stderr);
        return {
          success: false,
          error: `Bun bundling failed: ${stderrText}`,
          durationMs: Date.now() - startTime,
        };
      }

      context.log.info("Bundling completed successfully");
    } catch (error) {
      return {
        success: false,
        error: `Failed to run Bun bundler: ${String(error)}`,
        durationMs: Date.now() - startTime,
      };
    }

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
 * Process a single file - transform imports and APIs.
 */
async function processFile(
  file: string,
  context: PluginContext,
  mappings: Record<string, string>,
): Promise<string> {
  const relativePath = getRelativePath(file, context.sourceDir);
  const outputPath = `${context.outputDir}/${relativePath}`;

  // Ensure directory exists
  const outputDirPath = getDirectory(outputPath);
  if (outputDirPath) {
    await ensureDirectory(outputDirPath);
  }

  // Read and transform content
  let content = await Deno.readTextFile(file);
  content = transformImports(content, mappings);
  content = transformDenoAPIs(content);

  // Write transformed content
  await Deno.writeTextFile(outputPath, content);
  context.log.debug(`Transformed: ${relativePath}`);

  return outputPath;
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
 * Transform import statements using the provided mappings.
 */
function transformImports(content: string, mappings: Record<string, string>): string {
  let result = content;

  for (const [from, to] of Object.entries(mappings)) {
    // Pre-escape the 'from' pattern for use in regex
    const escapedFrom = escapeRegex(from);

    // Handle various import patterns
    const patterns = [
      // from "package"
      new RegExp(`from\\s+["']${escapedFrom}["']`, "g"),
      // from "package@version"
      new RegExp(`from\\s+["']${escapedFrom}@[^"']+["']`, "g"),
      // import "package" (side-effect import)
      new RegExp(`import\\s+["']${escapedFrom}["']`, "g"),
    ];

    for (const pattern of patterns) {
      result = result.replace(pattern, (match) => match.replace(from, to));
    }
  }

  return result;
}

/**
 * Transform Deno-specific APIs to Bun/Node equivalents.
 */
function transformDenoAPIs(content: string): string {
  let result = content;

  for (const rule of API_TRANSFORM_RULES) {
    // Reset regex lastIndex for safety
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replacement);
  }

  return result;
}

/**
 * Build the arguments array for bun build command.
 */
function buildBundleArgs(
  entryPoint: string,
  target: string,
  minify: boolean,
  sourcemap: string,
): string[] {
  const args = [
    "build",
    entryPoint,
    "--outdir",
    "./dist",
    "--target",
    target,
  ];

  if (minify) {
    args.push("--minify");
  }

  if (sourcemap !== "none") {
    args.push(`--sourcemap=${sourcemap}`);
  }

  return args;
}

/**
 * Generate package.json for the Bun output.
 */
function generatePackageJson(
  context: PluginContext,
  options: DenoToBunOptions | undefined,
): Record<string, unknown> {
  const name = (context.variables.config["name"] as string | undefined) ?? "package";
  const version = (context.variables.config["version"] as string | undefined) ?? "0.0.0";
  const entryPoint = options?.entryPoint ?? "mod.ts";

  const jsEntry = entryPoint.replace(/\.ts$/, ".js");
  const dtsEntry = entryPoint.replace(/\.ts$/, ".d.ts");

  return {
    name,
    version,
    type: "module",
    main: jsEntry,
    module: jsEntry,
    types: dtsEntry,
    exports: {
      ".": {
        import: `./${jsEntry}`,
        types: `./${dtsEntry}`,
      },
    },
    scripts: {
      test: "bun test",
    },
    engines: {
      bun: ">=1.0.0",
    },
  };
}

// =============================================================================
// Export
// =============================================================================

export default denoToBunPlugin;
export { denoToBunPlugin };
