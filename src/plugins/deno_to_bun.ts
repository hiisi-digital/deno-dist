/**
 * @module deno-to-bun
 *
 * Plugin for transforming Deno code to Bun.
 * Bun has high compatibility with Deno, so this plugin primarily handles
 * import remapping and Deno-specific API shims.
 */

import { escapeRegex } from "../template.ts";
import type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult } from "../types.ts";

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
const DEFAULT_MAPPINGS: Record<string, string> = {
  "jsr:@std/assert": "bun:test",
  "jsr:@std/path": "node:path",
  "jsr:@std/fs": "node:fs/promises",
};

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
    await Deno.mkdir(context.outputDir, { recursive: true });

    // Copy and transform all TypeScript files
    const files = await collectTypeScriptFiles(context.sourceDir);

    // Process all files in parallel
    const processFile = async (file: string): Promise<string> => {
      const relativePath = file.slice(context.sourceDir.length + 1);
      const outputPath = `${context.outputDir}/${relativePath}`;

      // Ensure directory exists
      const outputDirPath = outputPath.substring(0, outputPath.lastIndexOf("/"));
      if (outputDirPath) {
        await Deno.mkdir(outputDirPath, { recursive: true });
      }

      // Read and transform content
      let content = await Deno.readTextFile(file);
      content = transformImports(content, mappings);
      content = transformDenoAPIs(content);

      // Write transformed content
      await Deno.writeTextFile(outputPath, content);
      context.log.debug(`Transformed: ${relativePath}`);
      return outputPath;
    };

    const processedFiles = await Promise.all(files.map(processFile));
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
    const copyPromises = filesToCopy.map(async (file) => {
      const srcPath = `${context.sourceDir}/${file}`;
      const destPath = `${context.outputDir}/${file}`;
      try {
        await Deno.copyFile(srcPath, destPath);
        return { file, destPath, success: true as const };
      } catch {
        return { file, success: false as const };
      }
    });

    const copyResults = await Promise.all(copyPromises);
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
        args.push("--sourcemap=" + sourcemap);
      }

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
 * Recursively collect all TypeScript files in a directory.
 */
async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;

    if (entry.isDirectory) {
      // Skip common non-source directories
      if (["node_modules", ".git", "target", "dist"].includes(entry.name)) {
        continue;
      }
      const subFiles = await collectTypeScriptFiles(path);
      files.push(...subFiles);
    } else if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      // Skip test files
      if (entry.name.includes(".test.") || entry.name.includes("_test.")) {
        continue;
      }
      files.push(path);
    }
  }

  return files;
}

/**
 * Transform import statements using the provided mappings.
 */
function transformImports(content: string, mappings: Record<string, string>): string {
  let result = content;

  for (const [from, to] of Object.entries(mappings)) {
    // Handle various import patterns
    const patterns = [
      new RegExp(`from\\s+["']${escapeRegex(from)}["']`, "g"),
      new RegExp(`from\\s+["']${escapeRegex(from)}@[^"']+["']`, "g"),
      new RegExp(`import\\s+["']${escapeRegex(from)}["']`, "g"),
    ];

    for (const pattern of patterns) {
      result = result.replace(pattern, (match) => {
        return match.replace(from, to);
      });
    }
  }

  return result;
}

/**
 * Transform Deno-specific APIs to Bun/Node equivalents.
 */
function transformDenoAPIs(content: string): string {
  let result = content;

  // Deno.readTextFile -> Bun.file().text()
  result = result.replace(
    /Deno\.readTextFile\(([^)]+)\)/g,
    "await Bun.file($1).text()",
  );

  // Deno.writeTextFile -> Bun.write()
  result = result.replace(
    /Deno\.writeTextFile\(([^,]+),\s*([^)]+)\)/g,
    "await Bun.write($1, $2)",
  );

  // Deno.env.get -> Bun.env or process.env
  result = result.replace(/Deno\.env\.get\(([^)]+)\)/g, "Bun.env[$1]");

  // Deno.cwd() -> process.cwd()
  result = result.replace(/Deno\.cwd\(\)/g, "process.cwd()");

  // Deno.exit -> process.exit
  result = result.replace(/Deno\.exit\(/g, "process.exit(");

  // Deno.args -> Bun.argv.slice(2) or process.argv.slice(2)
  result = result.replace(/Deno\.args/g, "Bun.argv.slice(2)");

  return result;
}

/**
 * Generate package.json for the Bun output.
 */
function generatePackageJson(
  context: PluginContext,
  options: DenoToBunOptions | undefined,
): Record<string, unknown> {
  const name = context.variables.config["name"] as string | undefined ?? "package";
  const version = context.variables.config["version"] as string | undefined ?? "0.0.0";
  const entryPoint = options?.entryPoint ?? "mod.ts";

  return {
    name,
    version,
    type: "module",
    main: entryPoint.replace(/\.ts$/, ".js"),
    module: entryPoint.replace(/\.ts$/, ".js"),
    types: entryPoint.replace(/\.ts$/, ".d.ts"),
    exports: {
      ".": {
        import: `./${entryPoint.replace(/\.ts$/, ".js")}`,
        types: `./${entryPoint.replace(/\.ts$/, ".d.ts")}`,
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
