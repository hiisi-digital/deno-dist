/**
 * @module deno-passthrough
 *
 * Plugin for copying Deno code as-is with optional transformations.
 * Useful for creating Deno-specific distributions or as a base for other plugins.
 */

import type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult } from "../types.ts";

// =============================================================================
// Plugin Metadata
// =============================================================================

const metadata: PluginMetadata = {
  id: "deno-passthrough",
  name: "Deno Passthrough",
  version: "0.1.0",
  description: "Copy Deno code as-is with optional transformations",
  targetRuntime: "deno",
  author: "Hiisi Digital",
  license: "MPL-2.0",
  repository: "https://github.com/hiisi-digital/deno-dist",
};

// =============================================================================
// Plugin Options
// =============================================================================

/**
 * Options for the deno-passthrough plugin.
 */
export interface DenoPassthroughOptions {
  /** Files/directories to include (glob patterns) */
  readonly include?: readonly string[];
  /** Files/directories to exclude (glob patterns) */
  readonly exclude?: readonly string[];
  /** Whether to copy non-TypeScript files (default: true) */
  readonly copyAssets?: boolean;
  /** Whether to strip comments from TypeScript files (default: false) */
  readonly stripComments?: boolean;
  /** Whether to strip test files (default: true) */
  readonly stripTests?: boolean;
  /** Additional files to always copy */
  readonly copyFiles?: readonly string[];
  /** Whether to generate/copy deno.json (default: true) */
  readonly copyDenoJson?: boolean;
  /** Custom transformations to apply */
  readonly transforms?: readonly {
    readonly pattern: string;
    readonly replacement: string;
  }[];
}

// =============================================================================
// Plugin Implementation
// =============================================================================

/**
 * Create the deno-passthrough plugin.
 */
const denoPassthroughPlugin: Plugin = {
  metadata,

  /**
   * Preprocess phase: Validate configuration.
   */
  async preprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const startTime = Date.now();

    context.log.info("Preparing Deno passthrough...");

    // Validate source directory exists
    try {
      const stat = await Deno.stat(context.sourceDir);
      if (!stat.isDirectory) {
        return {
          success: false,
          error: `Source path is not a directory: ${context.sourceDir}`,
          durationMs: Date.now() - startTime,
        };
      }
    } catch {
      return {
        success: false,
        error: `Source directory not found: ${context.sourceDir}`,
        durationMs: Date.now() - startTime,
      };
    }

    context.log.info("Source directory validated");

    return {
      success: true,
      durationMs: Date.now() - startTime,
    };
  },

  /**
   * Transform phase: Copy and optionally transform Deno code.
   */
  async transform(context: PluginContext): Promise<PluginPhaseResult> {
    const startTime = Date.now();
    const affectedFiles: string[] = [];

    context.log.info("Copying Deno source files...");

    const options = context.pluginConfig.options as DenoPassthroughOptions | undefined;
    const stripTests = options?.stripTests ?? true;
    const copyAssets = options?.copyAssets ?? true;
    const transforms = options?.transforms ?? [];

    // Create output directory
    await Deno.mkdir(context.outputDir, { recursive: true });

    // Collect files to copy
    const files = await collectFiles(context.sourceDir, {
      include: options?.include,
      exclude: options?.exclude,
      stripTests,
      copyAssets,
    });

    // Process all files in parallel
    const processFile = async (file: string): Promise<string> => {
      const relativePath = file.slice(context.sourceDir.length + 1);
      const outputPath = `${context.outputDir}/${relativePath}`;

      // Ensure directory exists
      const outputDirPath = outputPath.substring(0, outputPath.lastIndexOf("/"));
      if (outputDirPath) {
        await Deno.mkdir(outputDirPath, { recursive: true });
      }

      // Check if this is a TypeScript file that needs transformation
      if (file.endsWith(".ts") || file.endsWith(".tsx")) {
        let content = await Deno.readTextFile(file);

        // Strip comments if requested
        if (options?.stripComments) {
          content = stripTypeScriptComments(content);
        }

        // Apply custom transforms
        for (const transform of transforms) {
          const regex = new RegExp(transform.pattern, "g");
          content = content.replace(regex, transform.replacement);
        }

        await Deno.writeTextFile(outputPath, content);
      } else {
        // Copy non-TypeScript files directly
        await Deno.copyFile(file, outputPath);
      }

      context.log.debug(`Copied: ${relativePath}`);
      return outputPath;
    };

    const processedFiles = await Promise.all(files.map(processFile));
    affectedFiles.push(...processedFiles);

    // Copy deno.json if requested
    if (options?.copyDenoJson !== false) {
      try {
        const srcPath = `${context.sourceDir}/deno.json`;
        const destPath = `${context.outputDir}/deno.json`;
        await Deno.copyFile(srcPath, destPath);
        affectedFiles.push(destPath);
        context.log.debug("Copied deno.json");
      } catch {
        // Try deno.jsonc
        try {
          const srcPath = `${context.sourceDir}/deno.jsonc`;
          const destPath = `${context.outputDir}/deno.jsonc`;
          await Deno.copyFile(srcPath, destPath);
          affectedFiles.push(destPath);
          context.log.debug("Copied deno.jsonc");
        } catch {
          // No deno.json(c) found
        }
      }
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

    context.log.info(`Passthrough completed. ${affectedFiles.length} files copied.`);

    return {
      success: true,
      affectedFiles,
      durationMs: Date.now() - startTime,
    };
  },

  /**
   * Postprocess phase: Optional validation.
   */
  async postprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const startTime = Date.now();

    context.log.info("Validating Deno output...");

    // Try to run deno check on the output
    try {
      const modPath = `${context.outputDir}/mod.ts`;
      try {
        await Deno.stat(modPath);
      } catch {
        // No mod.ts, skip validation
        context.log.info("No mod.ts found, skipping type check");
        return {
          success: true,
          durationMs: Date.now() - startTime,
        };
      }

      const command = new Deno.Command("deno", {
        args: ["check", "mod.ts"],
        cwd: context.outputDir,
        stdout: "piped",
        stderr: "piped",
      });

      const { code, stderr } = await command.output();

      if (code !== 0) {
        const stderrText = new TextDecoder().decode(stderr);
        context.log.warn(`Type check failed: ${stderrText}`);
        return {
          success: true, // Non-fatal warning
          warnings: [`Type check failed: ${stderrText}`],
          durationMs: Date.now() - startTime,
        };
      }

      context.log.info("Type check passed");
    } catch (error) {
      context.log.warn(`Could not run type check: ${String(error)}`);
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
 * Collect files from a directory with filtering.
 */
async function collectFiles(
  dir: string,
  options: {
    include?: readonly string[];
    exclude?: readonly string[];
    stripTests: boolean;
    copyAssets: boolean;
  },
): Promise<string[]> {
  const files: string[] = [];
  const excludeDirs = ["node_modules", ".git", "target", "dist", "coverage", "npm"];

  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;

    if (entry.isDirectory) {
      // Skip excluded directories
      if (excludeDirs.includes(entry.name)) {
        continue;
      }
      // Check custom exclude patterns
      if (options.exclude?.some((pattern) => matchGlob(entry.name, pattern))) {
        continue;
      }
      const subFiles = await collectFiles(path, options);
      files.push(...subFiles);
    } else if (entry.isFile) {
      // Skip test files if requested
      if (
        options.stripTests &&
        (entry.name.includes(".test.") ||
          entry.name.includes("_test.") ||
          entry.name.endsWith("_test.ts"))
      ) {
        continue;
      }

      // Check if file matches include patterns
      if (options.include && options.include.length > 0) {
        if (!options.include.some((pattern) => matchGlob(entry.name, pattern))) {
          continue;
        }
      }

      // Check custom exclude patterns
      if (options.exclude?.some((pattern) => matchGlob(entry.name, pattern))) {
        continue;
      }

      // Only copy TypeScript files unless copyAssets is true
      const isTypeScript = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
      if (isTypeScript || options.copyAssets) {
        files.push(path);
      }
    }
  }

  return files;
}

/**
 * Simple glob pattern matching.
 */
function matchGlob(name: string, pattern: string): boolean {
  // Convert glob to regex
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(name);
}

/**
 * Strip comments from TypeScript code.
 * Note: This is a simple implementation and may not handle all edge cases.
 */
function stripTypeScriptComments(content: string): string {
  let result = "";
  let inString = false;
  let stringChar = "";
  let inSingleLineComment = false;
  let inMultiLineComment = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    // Handle string literals
    if (!inSingleLineComment && !inMultiLineComment) {
      if ((char === '"' || char === "'" || char === "`") && content[i - 1] !== "\\") {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
      }
    }

    // Handle comments
    if (!inString) {
      // Check for single-line comment
      if (char === "/" && nextChar === "/" && !inMultiLineComment) {
        inSingleLineComment = true;
        i += 2;
        continue;
      }

      // Check for multi-line comment
      if (char === "/" && nextChar === "*" && !inSingleLineComment) {
        inMultiLineComment = true;
        i += 2;
        continue;
      }

      // End of single-line comment
      if (inSingleLineComment && char === "\n") {
        inSingleLineComment = false;
        result += char;
        i++;
        continue;
      }

      // End of multi-line comment
      if (inMultiLineComment && char === "*" && nextChar === "/") {
        inMultiLineComment = false;
        i += 2;
        continue;
      }
    }

    // Add character to result if not in a comment
    if (!inSingleLineComment && !inMultiLineComment) {
      result += char;
    }

    i++;
  }

  return result;
}

// =============================================================================
// Export
// =============================================================================

export default denoPassthroughPlugin;
export { denoPassthroughPlugin };
