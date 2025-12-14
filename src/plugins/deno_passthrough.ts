/**
 * @module deno-passthrough
 *
 * Plugin for copying Deno code as-is with optional transformations.
 * Useful for creating Deno-specific distributions or as a base for other plugins.
 */

import type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult } from "../types.ts";
import {
  collectFiles,
  type CollectFilesOptions,
  type CopyResult,
  ensureDirectory,
  getDirectory,
  getRelativePath,
  tryCopyFile,
} from "./utils.ts";

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
// Comment Stripping State Machine
// =============================================================================

const enum CommentState {
  Normal = 0,
  InString = 1,
  InSingleLineComment = 2,
  InMultiLineComment = 3,
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
    const stripComments = options?.stripComments ?? false;

    // Create output directory
    await ensureDirectory(context.outputDir);

    // Collect files to copy
    const collectOptions: CollectFilesOptions = {
      include: options?.include,
      exclude: options?.exclude,
      includeTests: !stripTests,
      includeAssets: copyAssets,
    };

    const files = await collectFiles(context.sourceDir, collectOptions);

    // Process all files in parallel
    const processedFiles = await Promise.all(
      files.map((file) =>
        processFile(file, context, {
          stripComments,
          transforms,
        })
      ),
    );
    affectedFiles.push(...processedFiles);

    // Copy deno.json if requested
    if (options?.copyDenoJson !== false) {
      const denoJsonPath = await copyDenoConfig(context);
      if (denoJsonPath) {
        affectedFiles.push(denoJsonPath);
        context.log.debug("Copied deno config");
      }
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

    try {
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
 * Process a single file - copy or transform.
 */
async function processFile(
  file: string,
  context: PluginContext,
  options: {
    stripComments: boolean;
    transforms: readonly { pattern: string; replacement: string }[];
  },
): Promise<string> {
  const relativePath = getRelativePath(file, context.sourceDir);
  const outputPath = `${context.outputDir}/${relativePath}`;

  // Ensure directory exists
  const outputDirPath = getDirectory(outputPath);
  if (outputDirPath) {
    await ensureDirectory(outputDirPath);
  }

  // Check if this is a TypeScript file that needs transformation
  if (file.endsWith(".ts") || file.endsWith(".tsx")) {
    let content = await Deno.readTextFile(file);

    // Strip comments if requested
    if (options.stripComments) {
      content = stripTypeScriptComments(content);
    }

    // Apply custom transforms
    for (const transform of options.transforms) {
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
}

/**
 * Copy deno.json or deno.jsonc if it exists.
 */
async function copyDenoConfig(context: PluginContext): Promise<string | null> {
  // Try deno.json first
  try {
    const srcPath = `${context.sourceDir}/deno.json`;
    const destPath = `${context.outputDir}/deno.json`;
    await Deno.copyFile(srcPath, destPath);
    return destPath;
  } catch {
    // Try deno.jsonc
    try {
      const srcPath = `${context.sourceDir}/deno.jsonc`;
      const destPath = `${context.outputDir}/deno.jsonc`;
      await Deno.copyFile(srcPath, destPath);
      return destPath;
    } catch {
      return null;
    }
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
 * Strip comments from TypeScript code.
 * Uses a state machine to handle strings and comments correctly.
 */
function stripTypeScriptComments(content: string): string {
  const result: string[] = [];
  let state: CommentState = CommentState.Normal;
  let stringChar = "";
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1] ?? "";
    const prevChar = i > 0 ? content[i - 1] : "";

    switch (state) {
      case CommentState.Normal:
        // Check for string start
        if ((char === '"' || char === "'" || char === "`") && prevChar !== "\\") {
          state = CommentState.InString;
          stringChar = char;
          result.push(char);
        } // Check for single-line comment
        else if (char === "/" && nextChar === "/") {
          state = CommentState.InSingleLineComment;
          i++; // Skip the second /
        } // Check for multi-line comment
        else if (char === "/" && nextChar === "*") {
          state = CommentState.InMultiLineComment;
          i++; // Skip the *
        } else {
          result.push(char);
        }
        break;

      case CommentState.InString:
        result.push(char);
        // Check for string end (not escaped)
        if (char === stringChar && prevChar !== "\\") {
          state = CommentState.Normal;
        }
        break;

      case CommentState.InSingleLineComment:
        // End at newline
        if (char === "\n") {
          state = CommentState.Normal;
          result.push(char);
        }
        // Skip all other characters in comment
        break;

      case CommentState.InMultiLineComment:
        // End at */
        if (char === "*" && nextChar === "/") {
          state = CommentState.Normal;
          i++; // Skip the /
        }
        // Skip all other characters in comment
        break;
    }

    i++;
  }

  return result.join("");
}

// =============================================================================
// Export
// =============================================================================

export default denoPassthroughPlugin;
export { denoPassthroughPlugin };
