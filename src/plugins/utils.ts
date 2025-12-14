/**
 * @module plugins/utils
 *
 * Shared utility functions for plugins.
 * Contains common file system operations, command execution, transformation helpers,
 * and plugin option validation utilities.
 */

import type { PluginContext, PluginPhaseResult } from "../types.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for collecting files from a directory.
 */
export interface CollectFilesOptions {
  /** File extensions to include (e.g., [".ts", ".tsx"]) */
  readonly extensions?: readonly string[];
  /** Glob patterns for files to include */
  readonly include?: readonly string[];
  /** Glob patterns for files to exclude */
  readonly exclude?: readonly string[];
  /** Whether to include test files (default: false) */
  readonly includeTests?: boolean;
  /** Whether to include non-code assets (default: false) */
  readonly includeAssets?: boolean;
  /** Directories to always skip */
  readonly skipDirs?: readonly string[];
}

/**
 * Default directories to skip when collecting files.
 */
const DEFAULT_SKIP_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "target",
  "dist",
  "coverage",
  "npm",
  ".cache",
  ".vscode",
  ".idea",
];

/**
 * Default TypeScript extensions.
 */
const TS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Patterns that indicate test files.
 */
const TEST_PATTERNS: readonly string[] = [
  ".test.",
  "_test.",
  ".spec.",
  "_spec.",
  "__tests__",
];

// =============================================================================
// File Collection
// =============================================================================

/**
 * Recursively collect files from a directory with filtering.
 *
 * @param dir Directory to scan
 * @param options Collection options
 * @returns Array of absolute file paths
 */
export async function collectFiles(
  dir: string,
  options: CollectFilesOptions = {},
): Promise<string[]> {
  const files: string[] = [];
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(options.skipDirs ?? [])]);
  const extensions = options.extensions ?? TS_EXTENSIONS;
  const includeTests = options.includeTests ?? false;
  const includeAssets = options.includeAssets ?? false;

  await collectFilesRecursive(dir, files, {
    skipDirs,
    extensions: new Set(extensions),
    include: options.include,
    exclude: options.exclude,
    includeTests,
    includeAssets,
  });

  return files;
}

/**
 * Internal recursive file collection.
 */
async function collectFilesRecursive(
  dir: string,
  files: string[],
  options: {
    skipDirs: Set<string>;
    extensions: Set<string>;
    include?: readonly string[];
    exclude?: readonly string[];
    includeTests: boolean;
    includeAssets: boolean;
  },
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;

      if (entry.isDirectory) {
        // Skip excluded directories
        if (options.skipDirs.has(entry.name)) {
          continue;
        }
        // Check custom exclude patterns
        if (options.exclude?.some((pattern) => matchGlob(entry.name, pattern))) {
          continue;
        }
        await collectFilesRecursive(path, files, options);
      } else if (entry.isFile) {
        // Skip test files if not including them
        if (!options.includeTests && isTestFile(entry.name)) {
          continue;
        }

        // Check include patterns
        if (options.include && options.include.length > 0) {
          if (!options.include.some((pattern) => matchGlob(entry.name, pattern))) {
            continue;
          }
        }

        // Check exclude patterns
        if (options.exclude?.some((pattern) => matchGlob(entry.name, pattern))) {
          continue;
        }

        // Check file extension
        const ext = getExtension(entry.name);
        const isSourceFile = options.extensions.has(ext);

        if (isSourceFile || options.includeAssets) {
          files.push(path);
        }
      }
    }
  } catch (error) {
    // Silently skip directories we can't read
    if (!(error instanceof Deno.errors.PermissionDenied)) {
      throw error;
    }
  }
}

/**
 * Check if a filename indicates a test file.
 */
function isTestFile(name: string): boolean {
  const lowerName = name.toLowerCase();
  return TEST_PATTERNS.some((pattern) => lowerName.includes(pattern));
}

/**
 * Get the file extension (including the dot).
 */
function getExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot >= 0 ? name.slice(lastDot) : "";
}

// =============================================================================
// Glob Matching
// =============================================================================

/**
 * Simple glob pattern matching.
 * Supports * (any characters) and ? (single character).
 *
 * @param name String to match
 * @param pattern Glob pattern
 * @returns Whether the string matches the pattern
 */
export function matchGlob(name: string, pattern: string): boolean {
  // Convert glob to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars except * and ?
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexPattern}$`).test(name);
}

// =============================================================================
// File Operations
// =============================================================================

/**
 * Ensure a directory exists, creating it if necessary.
 *
 * @param path Directory path
 */
export async function ensureDirectory(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (error) {
    // Ignore if already exists
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      throw error;
    }
  }
}

/**
 * Copy a file, creating the destination directory if needed.
 *
 * @param src Source path
 * @param dest Destination path
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  const destDir = dest.substring(0, dest.lastIndexOf("/"));
  if (destDir) {
    await ensureDirectory(destDir);
  }
  await Deno.copyFile(src, dest);
}

/**
 * Get the relative path from a base directory.
 *
 * @param fullPath Full file path
 * @param baseDir Base directory
 * @returns Relative path
 */
export function getRelativePath(fullPath: string, baseDir: string): string {
  const base = baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
  if (fullPath.startsWith(base)) {
    return fullPath.slice(base.length);
  }
  return fullPath;
}

/**
 * Get the directory portion of a path.
 *
 * @param path File path
 * @returns Directory path
 */
export function getDirectory(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash >= 0 ? path.slice(0, lastSlash) : "";
}

// =============================================================================
// Copy Result Types
// =============================================================================

/**
 * Result of a file copy operation.
 */
export type CopyResult =
  | { success: true; file: string; destPath: string }
  | { success: false; file: string; error: string };

/**
 * Try to copy a file, returning a result object.
 *
 * @param srcPath Source file path
 * @param destPath Destination file path
 * @param file Original file name for result
 * @returns Copy result
 */
export async function tryCopyFile(
  srcPath: string,
  destPath: string,
  file: string,
): Promise<CopyResult> {
  try {
    await copyFile(srcPath, destPath);
    return { success: true, file, destPath };
  } catch (error) {
    return { success: false, file, error: String(error) };
  }
}

// =============================================================================
// Text Processing
// =============================================================================

/**
 * Escape special regex characters in a string.
 *
 * @param text Text to escape
 * @returns Escaped text safe for use in RegExp
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// Plugin Option Validation
// =============================================================================

/**
 * Validation error with field path.
 */
export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

/**
 * Result of option validation.
 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

/**
 * Validate that required fields are present.
 */
export function validateRequired(
  options: Record<string, unknown>,
  fields: readonly string[],
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const field of fields) {
    if (options[field] === undefined || options[field] === null) {
      errors.push({ field, message: `${field} is required` });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that a field is a string.
 */
export function validateString(
  value: unknown,
  field: string,
): ValidationError | null {
  if (value !== undefined && typeof value !== "string") {
    return { field, message: `${field} must be a string` };
  }
  return null;
}

/**
 * Validate that a field is a boolean.
 */
export function validateBoolean(
  value: unknown,
  field: string,
): ValidationError | null {
  if (value !== undefined && typeof value !== "boolean") {
    return { field, message: `${field} must be a boolean` };
  }
  return null;
}

/**
 * Validate that a field is an array.
 */
export function validateArray(
  value: unknown,
  field: string,
): ValidationError | null {
  if (value !== undefined && !Array.isArray(value)) {
    return { field, message: `${field} must be an array` };
  }
  return null;
}

/**
 * Validate that a field is one of the allowed values.
 */
export function validateOneOf<T>(
  value: T,
  field: string,
  allowed: readonly T[],
): ValidationError | null {
  if (value !== undefined && !allowed.includes(value)) {
    return { field, message: `${field} must be one of: ${allowed.join(", ")}` };
  }
  return null;
}

/**
 * Validate that a file exists.
 */
export async function validateFileExists(
  path: string,
  field: string,
): Promise<ValidationError | null> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) {
      return { field, message: `${field} must be a file, not a directory` };
    }
    return null;
  } catch {
    return { field, message: `${field} file not found: ${path}` };
  }
}

/**
 * Validate that a directory exists.
 */
export async function validateDirectoryExists(
  path: string,
  field: string,
): Promise<ValidationError | null> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) {
      return { field, message: `${field} must be a directory, not a file` };
    }
    return null;
  } catch {
    return { field, message: `${field} directory not found: ${path}` };
  }
}

// =============================================================================
// Plugin Context Helpers
// =============================================================================

/**
 * Get a typed option value from the plugin context.
 */
export function getOption<T>(
  context: PluginContext,
  key: string,
  defaultValue: T,
): T {
  const options = context.pluginConfig.options as Record<string, unknown> | undefined;
  const value = options?.[key];
  return value !== undefined ? (value as T) : defaultValue;
}

/**
 * Get the package name from context, falling back to defaults.
 */
export function getPackageName(context: PluginContext): string {
  const configName = context.variables.config["name"];
  return typeof configName === "string" && configName.length > 0 ? configName : "package";
}

/**
 * Get the package version from context, falling back to defaults.
 */
export function getPackageVersion(context: PluginContext): string {
  const configVersion = context.variables.config["version"];
  return typeof configVersion === "string" && configVersion.length > 0 ? configVersion : "0.0.0";
}

// =============================================================================
// Result Helpers
// =============================================================================

/**
 * Create a successful plugin phase result.
 */
export function successResult(options?: {
  durationMs?: number;
  affectedFiles?: string[];
  warnings?: string[];
}): PluginPhaseResult {
  return {
    success: true,
    durationMs: options?.durationMs,
    affectedFiles: options?.affectedFiles?.length ? options.affectedFiles : undefined,
    warnings: options?.warnings?.length ? options.warnings : undefined,
  };
}

/**
 * Create a failed plugin phase result.
 */
export function failureResult(error: string, durationMs?: number): PluginPhaseResult {
  return {
    success: false,
    error,
    durationMs,
  };
}

/**
 * Measure execution time and return a result creator.
 */
export function createTimer(): { elapsed: () => number } {
  const startTime = Date.now();
  return {
    elapsed: () => Date.now() - startTime,
  };
}

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Result of command execution.
 */
export type CommandResult =
  | { success: true; stdout: string; stderr: string }
  | { success: false; error: string; code?: number; stderr?: string };

/**
 * Options for running a command.
 */
export interface RunCommandOptions {
  /** Command to run (e.g., "deno", "bun", "npm") */
  readonly command: string;
  /** Command arguments */
  readonly args: readonly string[];
  /** Working directory */
  readonly cwd?: string;
  /** Whether to capture output for verbose logging */
  readonly captureOutput?: boolean;
}

/**
 * Run a command and return the result.
 */
export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  try {
    const command = new Deno.Command(options.command, {
      args: [...options.args],
      cwd: options.cwd,
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();
    const decoder = new TextDecoder();
    const stdoutText = decoder.decode(stdout);
    const stderrText = decoder.decode(stderr);

    if (code !== 0) {
      return {
        success: false,
        error: `Command failed with exit code ${code}`,
        code,
        stderr: stderrText,
      };
    }

    return {
      success: true,
      stdout: stdoutText,
      stderr: stderrText,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to run command: ${String(error)}`,
    };
  }
}

/**
 * Run a Deno script with full permissions.
 */
export function runDenoScript(
  scriptPath: string,
  cwd?: string,
): Promise<CommandResult> {
  return runCommand({
    command: "deno",
    args: ["run", "-A", scriptPath],
    cwd,
  });
}

// =============================================================================
// File Transformation
// =============================================================================

/**
 * Options for transforming files.
 */
export interface TransformFilesOptions {
  /** Source directory */
  readonly sourceDir: string;
  /** Output directory */
  readonly outputDir: string;
  /** Files to transform (full paths) */
  readonly files: readonly string[];
  /** Transform function to apply to file content */
  readonly transform: (content: string, filePath: string) => string;
  /** Log function for debug output */
  readonly log?: (message: string) => void;
}

/**
 * Transform multiple files in parallel.
 * Reads each file, applies the transform function, and writes to output.
 *
 * @returns Array of output file paths
 */
export function transformFiles(options: TransformFilesOptions): Promise<string[]> {
  const { sourceDir, outputDir, files, transform, log } = options;

  const processFile = async (file: string): Promise<string> => {
    const relativePath = getRelativePath(file, sourceDir);
    const outputPath = `${outputDir}/${relativePath}`;

    // Ensure directory exists
    const outputDirPath = getDirectory(outputPath);
    if (outputDirPath) {
      await ensureDirectory(outputDirPath);
    }

    // Read and transform content
    const content = await Deno.readTextFile(file);
    const transformed = transform(content, file);

    // Write transformed content
    await Deno.writeTextFile(outputPath, transformed);
    log?.(`Transformed: ${relativePath}`);

    return outputPath;
  };

  return Promise.all(files.map(processFile));
}

// =============================================================================
// Default Files
// =============================================================================

/** Default files to copy to distributions */
export const DEFAULT_COPY_FILES: readonly string[] = ["LICENSE", "README.md"];

/** Default entry point for packages */
export const DEFAULT_ENTRY_POINT = "mod.ts";
