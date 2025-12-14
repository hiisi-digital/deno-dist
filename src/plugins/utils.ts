/**
 * @module plugins/utils
 *
 * Shared utility functions for plugins.
 * Contains common file system operations and transformation helpers.
 */

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
