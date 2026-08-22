/**
 * @module plugins/utils
 *
 * Shared utility functions for plugins.
 * Contains common file system operations, command execution, transformation helpers,
 * and plugin option validation utilities.
 */

import type { PluginContext, PluginPhaseResult } from "../types.ts";

import {
  chmod,
  copyFile as copyFileRaw,
  isAlreadyExists,
  isPermissionDenied,
  mkdirp,
  platform,
  readDir,
  readText,
  run,
  stat,
  writeText,
} from "@hiisi/shimp";
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

  // Sorted, which it never was. The order came out of the filesystem's own
  // enumeration, and it feeds transforms, manifests and dependency derivation,
  // so the same source could produce differently-ordered output on two machines.
  // Sorting also frees the walk to recurse in parallel.
  return files.sort();
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
  const subdirectories: string[] = [];
  try {
    for (const entry of await readDir(dir)) {
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
        subdirectories.push(path);
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
    if (!isPermissionDenied(error)) {
      throw error;
    }
  }

  // Descending after the directory has been read, rather than inside the loop,
  // so one directory's subtrees are walked together. The result is sorted by
  // `collectFiles`, so the order they finish in does not reach a caller.
  await Promise.all(
    subdirectories.map((path) => collectFilesRecursive(path, files, options)),
  );
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
    await mkdirp(path);
  } catch (error) {
    // Ignore if already exists
    if (!isAlreadyExists(error)) {
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
  await copyFileRaw(src, dest);
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
    const info = await stat(path);
    if (!info.isFile) {
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
    const info = await stat(path);
    if (!info.isDirectory) {
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

/**
 * Registry metadata the source config carries, in the shape a package.json
 * takes it.
 *
 * A registry asks for more than a name and a version, and the source
 * deno.json usually already has the answers: description, license, author,
 * homepage, keywords, repository. Every generated manifest used to drop all
 * of them on the floor, so an npm publish of the output warned about the
 * license and showed an empty description for a package whose source had
 * both. Only fields that are actually present come through; nothing is
 * invented here.
 */
export function getPackageMetadata(context: PluginContext): Record<string, unknown> {
  const config = context.variables.config;
  const metadata: Record<string, unknown> = {};
  for (const key of ["description", "license", "author", "homepage"]) {
    const value = config[key];
    if (typeof value === "string" && value.length > 0) {
      metadata[key] = value;
    }
  }
  const keywords = config["keywords"];
  if (Array.isArray(keywords) && keywords.length > 0) {
    metadata["keywords"] = keywords;
  }
  // npm takes repository as a shorthand string or as an object; pass either
  const repository = config["repository"];
  if (
    (typeof repository === "string" && repository.length > 0) ||
    (repository !== null && typeof repository === "object")
  ) {
    metadata["repository"] = repository;
  }
  return metadata;
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
    const { success, status, stdout, stderr } = await run(options.command, options.args, {
      cwd: options.cwd,
    });

    if (!success) {
      return {
        success: false,
        error: `Command failed with exit code ${status}`,
        code: status ?? undefined,
        stderr,
      };
    }

    return { success: true, stdout, stderr };
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
  configPath?: string,
): Promise<CommandResult> {
  // A subprocess resolves its own config from its working directory and cannot
  // inherit the one its parent was started with. That is invisible until a
  // project depends on something unpublished, at which point the generated
  // script fails to resolve a specifier the project itself resolves fine.
  const config = configPath === undefined ? [] : ["-c", configPath];
  return runCommand({
    command: "deno",
    args: ["run", "-A", ...config, scriptPath],
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
    const content = await readText(file);
    const transformed = transform(content, file);

    // Write transformed content
    await writeText(outputPath, transformed);
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

// =============================================================================
// Dependency derivation
// =============================================================================

/** The npm registry that serves jsr packages, and where a `@jsr/` scope resolves. */
export const JSR_NPM_REGISTRY = "https://npm.jsr.io";

/** How {@link deriveDependencies} narrows an import map. */
export interface DeriveOptions {
  /**
   * Specifiers something else has already rewritten, usually to a built-in.
   *
   * Skipped, because a dependency declared for a specifier nothing imports any more is an
   * install of something unused, and for one rewritten to `bun:test` it is an install of
   * something that does not exist.
   */
  readonly alreadyMapped?: ReadonlySet<string>;
  /**
   * The specifiers the shipped files actually import, when the caller knows them.
   *
   * Omitting it takes the whole map, which is what a caller with nothing built yet has to do.
   */
  readonly used?: ReadonlySet<string>;
}

/** What a source config's imports come to once translated for npm. */
export interface DerivedDependencies {
  /** Import specifier to the npm package name it becomes. */
  readonly mappings: Readonly<Record<string, string>>;
  /** The `dependencies` block for a generated package.json. */
  readonly dependencies: Readonly<Record<string, string>>;
  /** Whether anything here needs the `@jsr` scope pointed at jsr's registry. */
  readonly needsJsrRegistry: boolean;
}

/**
 * The npm dependencies a Deno import map implies.
 *
 * A distribution that copies its imports through unchanged cannot resolve them: the runtime
 * has no import map and the manifest declares nothing, so the package fails on its own first
 * import. Every entry has to become a real npm dependency, and each of the three specifier
 * kinds becomes one differently.
 *
 * - **`npm:pkg@range`** is already an npm package. The specifier becomes `pkg` and the range
 *   is the version.
 * - **`jsr:@scope/name@range`** resolves through jsr's own npm-compatible registry, where it
 *   is published as `@jsr/scope__name`. That naming is jsr's, not a convention invented here,
 *   and it is why a `.npmrc` pointing the `@jsr` scope at `npm.jsr.io` travels with the
 *   package.
 * - **A relative or absolute path** is a file in the project and needs no dependency.
 *
 * What narrows the map is {@link DeriveOptions}.
 *
 * @example
 * ```ts
 * deriveDependencies(
 *   { "@hiisi/onlywhen": "jsr:@hiisi/onlywhen@^0.5.0", "chalk": "npm:chalk@^5" },
 * );
 * // mappings: { "@hiisi/onlywhen": "@jsr/hiisi__onlywhen", chalk: "chalk" }
 * // dependencies: { "@jsr/hiisi__onlywhen": "^0.5.0", chalk: "^5" }
 * // needsJsrRegistry: true
 * ```
 */
export function deriveDependencies(
  imports: Readonly<Record<string, unknown>>,
  options: DeriveOptions = {},
): DerivedDependencies {
  const { alreadyMapped = new Set<string>(), used } = options;
  const mappings: Record<string, string> = {};
  const dependencies: Record<string, string> = {};
  let needsJsrRegistry = false;

  for (const [specifier, target] of Object.entries(imports)) {
    if (typeof target !== "string") continue;
    if (alreadyMapped.has(specifier)) continue;
    // An import map is the whole project's, tests included, and the tests are not shipped.
    // Declaring a dependency the distribution never imports makes an install fetch something
    // unused, and for a test-only jsr package it makes the install fail outright: `@std/assert`
    // has no npm publication under its own name at all.
    if (used !== undefined && !used.has(specifier)) continue;

    if (target.startsWith("jsr:")) {
      const parsed = splitVersion(target.slice("jsr:".length));
      if (parsed === undefined) continue;
      const npmName = jsrToNpmName(parsed.name);
      if (npmName === undefined) continue;
      mappings[specifier] = npmName;
      dependencies[npmName] = parsed.range ?? "*";
      needsJsrRegistry = true;
      continue;
    }

    if (target.startsWith("npm:")) {
      const parsed = splitVersion(target.slice("npm:".length));
      if (parsed === undefined) continue;
      mappings[specifier] = parsed.name;
      dependencies[parsed.name] = parsed.range ?? "*";
    }

    // Anything else is a path into the project, or a protocol npm has no answer for. Left
    // alone rather than guessed at: a wrong dependency is worse than a missing one, because
    // it installs and then shadows the thing it was meant to be.
  }

  return { mappings, dependencies, needsJsrRegistry };
}

/**
 * A jsr package name as npm spells it on jsr's compatibility registry.
 *
 * `@hiisi/onlywhen` becomes `@jsr/hiisi__onlywhen`. Returns undefined for anything that is
 * not scoped, because jsr has no unscoped packages and a name that looks like one is a
 * malformed specifier rather than a case to handle.
 */
export function jsrToNpmName(jsrName: string): string | undefined {
  const match = /^@([^/]+)\/(.+)$/.exec(jsrName);
  if (match === null) return undefined;
  return `@jsr/${match[1]}__${match[2]}`;
}

/**
 * A package specifier split into its name and its version range.
 *
 * The `@` that separates them is the last one, and only when it is not the scope's, which is
 * why this is not a `split("@")`.
 */
function splitVersion(
  specifier: string,
): { name: string; range?: string } | undefined {
  if (specifier === "") return undefined;
  const at = specifier.lastIndexOf("@");
  if (at <= 0) return { name: specifier };
  return { name: specifier.slice(0, at), range: specifier.slice(at + 1) };
}

// =============================================================================
// Entry points
// =============================================================================

/** One export a package offers, as the subpath it is reached by and the file behind it. */
export interface EntryPoint {
  /** The subpath, `"."` for the root export. */
  readonly name: string;
  /** The file, relative to the package root. */
  readonly path: string;
}

/**
 * Every export a source config declares.
 *
 * A Deno config spells `exports` either as a string, meaning the package has one entry, or as
 * a map from subpath to file. Both become the same list here, with `"."` naming the root, so
 * a caller does not have to know which form it was written in.
 *
 * This exists because a distribution built from the first entry only is not the package: a
 * consumer doing `import { x } from "pkg/cli"` gets a resolution failure, and the failure is
 * invisible from the output directory, where the root export works perfectly.
 *
 * @param config - The source config, usually `deno.json`.
 * @param fallback - The entry to assume when the config declares none.
 *
 * @example
 * ```ts
 * entryPointsOf({ exports: { ".": "./mod.ts", "./cli": "./src/cli.ts" } });
 * // [{ name: ".", path: "./mod.ts" }, { name: "./cli", path: "./src/cli.ts" }]
 * ```
 */
export function entryPointsOf(
  config: Readonly<Record<string, unknown>>,
  fallback = "./mod.ts",
): EntryPoint[] {
  const exports = config["exports"];

  if (typeof exports === "string") {
    return [{ name: ".", path: exports }];
  }

  if (exports !== null && typeof exports === "object") {
    const entries: EntryPoint[] = [];
    for (const [name, path] of Object.entries(exports as Record<string, unknown>)) {
      if (typeof path !== "string") continue;
      // A non-JavaScript export, a JSON schema for instance, is reachable in Deno and is not
      // an entry point a bundler can compile. Carried through as a file rather than built.
      if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
      entries.push({ name, path });
    }
    // The root first, because dnt names the first entry `"."` regardless of what it was
    // called, so an ordering that puts a subpath there silently renames it.
    entries.sort((a, b) => (a.name === "." ? -1 : b.name === "." ? 1 : 0));
    if (entries.length > 0) return entries;
  }

  return [{ name: ".", path: fallback }];
}

/**
 * An npm `exports` map for a set of entry points.
 *
 * `.ts` sources keep their extension, because bun and deno both execute TypeScript directly
 * and a distribution that ships sources is resolved against those. A caller that compiles
 * first passes the compiled paths in.
 */
export function npmExportsOf(
  entries: readonly EntryPoint[],
): Record<string, { types: string; default: string }> {
  const map: Record<string, { types: string; default: string }> = {};
  for (const entry of entries) {
    const path = entry.path.startsWith("./") ? entry.path : `./${entry.path}`;
    map[entry.name] = { types: path, default: path };
  }
  return map;
}

/**
 * The compiler options a source config sets that a node build should inherit.
 *
 * The tool used to hand dnt a hardcoded `lib` and nothing else, so a package
 * that compiles under deno failed under dnt with a type error on every decorated
 * declaration, and one relying on emitted decorator metadata compiled with the
 * metadata absent.
 *
 * **This is a filter, not a validation.** dnt does not reject an option it does
 * not know: a build with `totallyNotARealTsOption: 42` in this object succeeds,
 * and `experimentalDecorators` is honoured despite being absent from dnt's own
 * `compilerOptions` type. Both were checked rather than assumed. So the list
 * exists to keep deno-specific options out of a node build, not to keep dnt
 * happy: `types: ["npm:@types/bun"]` and a `jsxImportSource` naming a
 * deno-resolved specifier are meaningful where they were written and wrong here.
 *
 * The list is dnt 0.43.2's own eighteen, plus `experimentalDecorators`. It
 * cannot be derived, so it is pinned instead: {@linkcode DNT_COMPILER_OPTIONS}
 * is the whole of it, `tests/decorators_test.ts` asserts its exact contents, and
 * the dnt version it tracks is pinned in `deno_to_node.ts`. An option a package
 * needs and this does not carry is a gap to close by naming it here, with a
 * reason, rather than a thing the code silently decides.
 *
 * `lib` is defaulted rather than fixed, because the target is node rather than
 * whatever the source was written against. A config naming its own wins, since a
 * package that says what it needs said it deliberately.
 */
export const DNT_COMPILER_OPTIONS: readonly string[] = [
  // dnt 0.43.2's `compilerOptions`, in the order its type declares them
  "importHelpers",
  "stripInternal",
  "strictBindCallApply",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "noImplicitAny",
  "noImplicitReturns",
  "noImplicitThis",
  "noStrictGenericChecks",
  "noUncheckedIndexedAccess",
  "target",
  "sourceMap",
  "inlineSources",
  "lib",
  "skipLibCheck",
  "emitDecoratorMetadata",
  "useUnknownInCatchVariables",
  // Not in dnt's type and reaches TypeScript anyway, which the decorated
  // fixture demonstrates: without it the build fails with TS1240 on every
  // decorated declaration.
  "experimentalDecorators",
];

/** The options this deliberately does not forward, and why. Asserted by the tests. */
export const DENO_ONLY_COMPILER_OPTIONS: Readonly<Record<string, string>> = {
  types: "names deno-resolved type roots, such as npm:@types/bun",
  jsx: "deno's jsx modes do not all exist for a node build",
  jsxImportSource: "names a specifier only deno resolves",
  jsxFactory: "meaningless without a jsx mode this does not forward",
  jsxFragmentFactory: "meaningless without a jsx mode this does not forward",
};

export function dntCompilerOptions(
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const declared = config["compilerOptions"];
  const options: Record<string, unknown> = { lib: ["ES2022", "DOM"] };
  if (declared === null || typeof declared !== "object") return options;

  for (const key of DNT_COMPILER_OPTIONS) {
    const value = (declared as Record<string, unknown>)[key];
    if (value !== undefined) options[key] = value;
  }
  return options;
}

/**
 * The commands a package installs, with each path put where the distribution
 * actually wrote it.
 *
 * A package that ships a command line tool declares it in its source config the
 * way npm spells it, as `bin`: either a map from command name to file, or a bare
 * string when the command is named after the package. Deno itself has no such
 * field and ignores the key, so the declaration costs the source nothing and is
 * read here.
 *
 * It cannot be inferred, and that is why it is declared. An export called
 * `./cli` is a subpath a consumer imports; whether it is also a command, and
 * what that command is called, is a separate fact. Deno's own installer guesses
 * from the file stem and treats `cli` as generic, which is the guess the
 * publishing discipline says to override with a name.
 *
 * `resolve` maps a source path to the built one: a compiled distribution passes
 * the function that renames `./cli.ts` to `./esm/cli.js`, and one that ships the
 * sources passes the identity.
 */
export function binOf(
  config: Readonly<Record<string, unknown>>,
  resolve: (sourcePath: string) => string,
): Record<string, string> {
  const declared = config["bin"];
  const map: Record<string, string> = {};

  if (typeof declared === "string" && declared.length > 0) {
    // The bare form names the package. npm resolves it to the unscoped half, so
    // `@hiisi/otso` installs a command called `otso` rather than one nobody can
    // type.
    const name = typeof config["name"] === "string" ? config["name"] : "";
    const command = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
    if (command.length > 0) map[command] = resolve(declared);
    return map;
  }

  if (declared !== null && typeof declared === "object") {
    for (const [command, path] of Object.entries(declared as Record<string, unknown>)) {
      if (typeof path !== "string" || path.length === 0) continue;
      map[command] = resolve(path);
    }
  }

  return map;
}

/**
 * The first line a command's entry point needs, per runtime.
 *
 * npm's own documentation is blunt about this: without it "the scripts are
 * started without the node executable", which is a package that installs
 * cleanly and then does nothing. It cannot come from the source, because the
 * line names the runtime and one source builds three distributions.
 *
 * Deno's is the `-S` form, which is what lets a single `env` argument carry the
 * subcommand and its flags. Deno installs a command from an export rather than
 * from a manifest field, so this one matters only for a file run directly.
 */
export const SHEBANG: Readonly<Record<string, string>> = {
  node: "#!/usr/bin/env node",
  bun: "#!/usr/bin/env bun",
  deno: "#!/usr/bin/env -S deno run -A",
};

/**
 * Turn a built file into something a shell can execute: the right first line,
 * and the mode bit that lets the kernel read it.
 *
 * Both, in one call, because they are one requirement and splitting them is how
 * the second gets forgotten. It was: with the shebang alone, `npm install`
 * produced a working command and `bun install` produced `Permission denied`.
 * npm copies the package and chmods whatever `bin` names, so it repairs the
 * omission on the way in; bun's `file:` install symlinks straight through to the
 * built tree, so the mode is whatever the build left, and the build left `644`.
 * A package that works under one installer and not the other is the shape that
 * ships, because whoever wrote it tested under the one that repairs it.
 *
 * The shebang replaces whatever was there rather than being prepended to it. A
 * source that carries one has it for whichever runtime its author ran it under,
 * and two is a syntax error in the worst available position: the second is read
 * as a private-field declaration at the top level.
 *
 * Throws when the file is not there. A `bin` naming a path that was never built
 * produces a package that installs and leaves a broken command on the PATH, so
 * the caller wants to hear about it rather than ship it.
 */
export async function makeRunnable(path: string, line: string): Promise<void> {
  const text = await readText(path);
  // A file that is nothing but a shebang has no newline to cut at, and
  // `indexOf` reporting -1 there would leave the old line in place and put the
  // new one above it. Explicit rather than arithmetic on a sentinel.
  const firstBreak = text.indexOf("\n");
  const body = !text.startsWith("#!") ? text : firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  await writeText(path, `${line}\n${body}`);
  // Windows has no mode bits and `chmod` throws there rather than doing
  // nothing, so the platform decides whether this step exists at all. A package
  // built on Windows and installed on a unix by npm still works, because npm
  // sets the bit itself; the one it would not survive is bun's symlink, and
  // that combination has no unix on either end.
  if (platform() !== "windows") await chmod(path, 0o755);
}

/**
 * Every bare specifier the given sources import.
 *
 * A bare specifier is one that is neither a path nor a protocol: `@hiisi/onlywhen` rather
 * than `./local.ts` or `node:fs`. Those are the ones an import map resolves and a built
 * package therefore has to declare.
 *
 * Regex rather than a parse, deliberately. This runs over the emitted output to decide what
 * to write into a manifest, and a full parse of every file to answer one question about its
 * import statements costs more than the answer is worth. The cost of being wrong is bounded
 * in the safe direction too: an over-match declares a dependency nothing uses, which installs
 * and sits there, where a parse failure would drop one and break the package.
 */
export function importedSpecifiers(sources: Iterable<string>): Set<string> {
  const found = new Set<string>();
  // `from "x"`, `import "x"`, and `import("x")`, which between them is every form that names
  // a module. The specifier is captured and filtered rather than matched precisely, because
  // the shapes a specifier can take are simpler to test than to express here.
  const pattern = /(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (/^[a-z][a-z0-9+.-]*:/.test(specifier)) continue;
      // A subpath import resolves through the package it names, so `@scope/pkg/sub` is a use
      // of `@scope/pkg`. Both are recorded, because an import map can key on either.
      found.add(specifier);
      const scoped = /^(@[^/]+\/[^/]+)\//.exec(specifier);
      if (scoped?.[1] !== undefined) found.add(scoped[1]);
      const bare = /^([^@][^/]*)\//.exec(specifier);
      if (bare?.[1] !== undefined) found.add(bare[1]);
    }
  }
  return found;
}

/**
 * The `#`-prefixed self-imports a source config declares, as npm spells them.
 *
 * Deno and Node both let a package refer to its own files by a name rather than by a path,
 * and both spell it with a leading `#`. Deno puts them in the same `imports` map as its
 * dependencies; Node has a separate `imports` field in package.json for exactly this, and bun
 * reads it too.
 *
 * A distribution that drops them ships files importing a name nothing resolves, which fails at
 * load with `Cannot find package '#core'` and is invisible until then: every file is present
 * and every path in the manifest exists.
 *
 * @example
 * ```ts
 * selfImportsOf({ imports: { "#core": "./core/mod.ts", "@std/fs": "jsr:@std/fs@^1" } });
 * // { "#core": "./core/mod.ts" }
 * ```
 */
export function selfImportsOf(
  config: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const imports = config["imports"];
  if (imports === null || typeof imports !== "object") return {};

  const self: Record<string, string> = {};
  for (const [name, target] of Object.entries(imports as Record<string, unknown>)) {
    if (!name.startsWith("#")) continue;
    if (typeof target !== "string") continue;
    // Node requires the target of a self-import to be a relative path, which is what a Deno
    // config uses for one anyway. Anything else is a dependency wearing a `#`, and npm has no
    // reading for it, so it is left out rather than written as something that will not resolve.
    if (!target.startsWith("./") && !target.startsWith("../")) continue;
    self[name] = target;
  }
  return self;
}
