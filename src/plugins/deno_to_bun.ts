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
  createTimer,
  DEFAULT_COPY_FILES,
  DEFAULT_ENTRY_POINT,
  deriveDependencies,
  ensureDirectory,
  entryPointsOf,
  escapeRegex,
  failureResult,
  getPackageMetadata,
  getPackageName,
  getPackageVersion,
  importedSpecifiers,
  JSR_NPM_REGISTRY,
  npmExportsOf,
  runCommand,
  selfImportsOf,
  successResult,
  transformFiles,
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
  // Keyed the way source imports them, which is the import map's key rather than the `jsr:`
  // target it points at. An earlier version keyed on `jsr:@std/path`, a form no import
  // statement contains, so none of these ever matched anything and all three were inert.
  "@std/assert": "bun:test",
  "@std/path": "node:path",
  "@std/fs": "node:fs/promises",
  "@std/testing": "bun:test",
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
  { pattern: /Deno\.readTextFile\(([^)]+)\)/g, replacement: "await Bun.file($1).text()" },
  { pattern: /Deno\.writeTextFile\(([^,]+),\s*([^)]+)\)/g, replacement: "await Bun.write($1, $2)" },
  { pattern: /Deno\.env\.get\(([^)]+)\)/g, replacement: "Bun.env[$1]" },
  { pattern: /Deno\.cwd\(\)/g, replacement: "process.cwd()" },
  { pattern: /Deno\.exit\(/g, replacement: "process.exit(" },
  { pattern: /Deno\.args\b/g, replacement: "Bun.argv.slice(2)" },
];

// =============================================================================
// Plugin Implementation
// =============================================================================

/**
 * The deno-to-bun plugin.
 */
const denoToBunPlugin: Plugin = {
  metadata,

  /**
   * Preprocess phase: Validate configuration and prepare environment.
   */
  async preprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const timer = createTimer();
    const warnings: string[] = [];

    context.log.info("Preparing Deno to Bun transformation...");

    const options = context.pluginConfig.options as DenoToBunOptions | undefined;
    const entryPoint = options?.entryPoint ?? DEFAULT_ENTRY_POINT;
    const fullEntryPath = `${context.sourceDir}/${entryPoint}`;

    // Validate entry point exists
    try {
      await Deno.stat(fullEntryPath);
    } catch {
      return failureResult(`Entry point not found: ${fullEntryPath}`, timer.elapsed());
    }

    context.log.info(`Entry point validated: ${entryPoint}`);

    // Warn about Deno-specific APIs that may need manual handling
    try {
      const content = await Deno.readTextFile(fullEntryPath);
      if (content.includes("Deno.")) {
        warnings.push("Source uses Deno.* APIs. Some may not be available in Bun.");
      }
    } catch {
      // Ignore read errors during preprocess
    }

    return successResult({ durationMs: timer.elapsed(), warnings });
  },

  /**
   * Transform phase: Copy and transform Deno code for Bun.
   */
  async transform(context: PluginContext): Promise<PluginPhaseResult> {
    const timer = createTimer();
    const affectedFiles: string[] = [];

    context.log.info("Transforming Deno code for Bun runtime...");

    const options = context.pluginConfig.options as DenoToBunOptions | undefined;
    const explicit = { ...DEFAULT_MAPPINGS, ...options?.mappings };

    const configImports = (context.variables.config["imports"] ?? {}) as Record<
      string,
      unknown
    >;

    // Create output directory
    await ensureDirectory(context.outputDir);

    // Collect TypeScript files (excluding tests)
    const files = await collectFiles(context.sourceDir, {
      extensions: [".ts", ".tsx"],
      includeTests: false,
      includeAssets: false,
    });

    // What the shipped files actually import decides the dependencies, rather than the whole
    // import map. The map is the project's and includes its tests, which are not shipped, so
    // declaring from it makes an install fetch something unused and for a test-only jsr
    // package makes it fail outright: `@std/assert` has no npm publication under its own name.
    const sources = await Promise.all(
      files.map((file) => Deno.readTextFile(file).catch(() => "")),
    );
    const derived = deriveDependencies(configImports, {
      alreadyMapped: new Set(Object.keys(explicit)),
      used: importedSpecifiers(sources),
    });
    const mappings = { ...explicit, ...derived.mappings };

    // Transform all files using the shared utility
    const transformer = createBunTransformer(mappings);
    const processedFiles = await transformFiles({
      sourceDir: context.sourceDir,
      outputDir: context.outputDir,
      files,
      transform: transformer,
      log: (msg) => context.log.debug(msg),
    });
    affectedFiles.push(...processedFiles);

    // Generate package.json if requested
    if (options?.generatePackageJson !== false) {
      const packageJson = generatePackageJson(context, options, derived.dependencies);
      const packageJsonPath = `${context.outputDir}/package.json`;
      await Deno.writeTextFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
      affectedFiles.push(packageJsonPath);
      context.log.debug("Generated package.json");

      // A jsr dependency is installable only from jsr's own npm-compatible registry, so the
      // scope has to be pointed at it. Shipping the .npmrc with the package is what makes
      // `bun install` and `npm install` work in the output directory without the consumer
      // knowing where the dependency came from.
      if (derived.needsJsrRegistry) {
        const npmrcPath = `${context.outputDir}/.npmrc`;
        await Deno.writeTextFile(npmrcPath, `@jsr:registry=${JSR_NPM_REGISTRY}\n`);
        affectedFiles.push(npmrcPath);
        context.log.debug("Generated .npmrc for the @jsr scope");
      }
    }

    // Copy additional files
    const filesToCopy = options?.copyFiles ?? DEFAULT_COPY_FILES;
    const copyResults = await Promise.all(
      filesToCopy.map((file) =>
        tryCopyFile(
          `${context.sourceDir}/${file}`,
          `${context.outputDir}/${file}`,
          file,
        )
      ),
    );

    for (const result of copyResults) {
      if (result.success) {
        affectedFiles.push(result.destPath);
        context.log.debug(`Copied: ${result.file}`);
      }
    }

    context.log.info(`Transformation completed. ${affectedFiles.length} files affected.`);

    return successResult({ durationMs: timer.elapsed(), affectedFiles });
  },

  /**
   * Postprocess phase: Optional bundling and optimization.
   */
  async postprocess(context: PluginContext): Promise<PluginPhaseResult> {
    const timer = createTimer();
    const options = context.pluginConfig.options as DenoToBunOptions | undefined;

    // If bundling is not requested, skip
    if (!options?.bundle) {
      context.log.info("Skipping bundling (not enabled)");
      return successResult({ durationMs: timer.elapsed() });
    }

    context.log.info("Bundling output with Bun...");

    const entryPoint = options?.entryPoint ?? DEFAULT_ENTRY_POINT;
    const args = buildBundleArgs(
      entryPoint,
      options?.target ?? "bun",
      options?.minify ?? false,
      options?.sourcemap ?? "external",
    );

    const result = await runCommand({
      command: "bun",
      args,
      cwd: context.outputDir,
    });

    if (!result.success) {
      return failureResult(
        `Bun bundling failed: ${result.stderr ?? result.error}`,
        timer.elapsed(),
      );
    }

    context.log.info("Bundling completed successfully");
    return successResult({ durationMs: timer.elapsed() });
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a transformer function for Bun conversion.
 */
function createBunTransformer(
  mappings: Record<string, string>,
): (content: string, filePath: string) => string {
  return (content: string, _filePath: string) => {
    let result = transformImports(content, mappings);
    result = transformDenoAPIs(result);
    return result;
  };
}

/**
 * Transform import statements using the provided mappings.
 */
function transformImports(content: string, mappings: Record<string, string>): string {
  let result = content;

  for (const [from, to] of Object.entries(mappings)) {
    const escapedFrom = escapeRegex(from);

    // Handle various import patterns
    const patterns = [
      new RegExp(`from\\s+["']${escapedFrom}["']`, "g"),
      new RegExp(`from\\s+["']${escapedFrom}@[^"']+["']`, "g"),
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
  const args = ["build", entryPoint, "--outdir", "./dist", "--target", target];

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
 *
 * The transform copies TypeScript sources; nothing here compiles anything.
 * So the manifest points at the .ts entry itself, which bun resolves and runs
 * natively, and which TypeScript reads its types straight out of. The first
 * version of this function rewrote the entries to .js and .d.ts names no step
 * ever emitted, and every package built by it failed to install: bun found no
 * file behind "main" and reported the whole package as missing. The manifest
 * describes what is on disk, never what a compile step would have produced.
 *
 * When bundling is enabled the entry moves to where bun build actually writes
 * it, and the types entry stays on the source file the bundle was built from.
 */
function generatePackageJson(
  context: PluginContext,
  options: DenoToBunOptions | undefined,
  dependencies: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const name = getPackageName(context);
  const version = getPackageVersion(context);
  const metadata = getPackageMetadata(context);
  const entryPoint = options?.entryPoint ?? DEFAULT_ENTRY_POINT;

  const entry = options?.bundle ? `dist/${entryPoint.replace(/\.ts$/, ".js")}` : entryPoint;
  const typesEntry = options?.bundle ? entryPoint : entry;

  // Bundling collapses everything into one file, so there is one entry and the config's
  // subpaths have nowhere to point. Unbundled, every export the config declares is a real
  // file in the output and gets a subpath, which is what a consumer importing `pkg/cli`
  // needs: a distribution built from the root export alone works perfectly from the output
  // directory and fails for them.
  // Node's package.json `imports` is the same feature a Deno config spells with a leading
  // `#`, and bun reads it too, so carrying them through is all that is needed: no rewriting,
  // and the files keep the names they were written with.
  const selfImports = selfImportsOf(context.variables.config);

  const exports = options?.bundle
    ? { ".": { types: `./${typesEntry}`, default: `./${entry}` } }
    : npmExportsOf(entryPointsOf(context.variables.config, entryPoint));

  return {
    name,
    version,
    ...metadata,
    type: "module",
    main: entry,
    module: entry,
    types: typesEntry,
    exports,
    ...(Object.keys(selfImports).length > 0 ? { imports: selfImports } : {}),
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    scripts: { test: "bun test" },
    engines: { bun: ">=1.0.0" },
  };
}

// =============================================================================
// Export
// =============================================================================

export default denoToBunPlugin;
export { denoToBunPlugin };
