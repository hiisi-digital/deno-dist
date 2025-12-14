/**
 * @module pipeline
 *
 * Pipeline orchestrator for running preprocess, transform, and postprocess phases.
 * Manages the execution order of plugins and custom scripts.
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { ResolvedPlugin } from "./plugins/mod.ts";
import { resolvePlugins } from "./plugins/mod.ts";
import { createVariablesFromContext } from "./template.ts";
import type {
  DistConfig,
  LogFunctions,
  PipelineOptions,
  PipelinePhase,
  PipelineResult,
  PluginContext,
  PluginPhaseResult,
} from "./types.ts";
import { PipelineError } from "./types.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Internal pipeline state.
 */
interface PipelineState {
  /** Phase results */
  readonly phaseResults: Record<PipelinePhase, PluginPhaseResult | undefined>;
  /** Start time */
  readonly startTime: number;
  /** Whether the pipeline has been aborted */
  aborted: boolean;
  /** Abort reason */
  abortReason?: string;
}

// =============================================================================
// Logging
// =============================================================================

/**
 * Create logging functions for pipeline execution.
 */
function createLogFunctions(verbose: boolean, distName: string): LogFunctions {
  const prefix = `[${distName}]`;

  return {
    info(message: string): void {
      // deno-lint-ignore no-console
      console.log(`${prefix} ${message}`);
    },
    warn(message: string): void {
      // deno-lint-ignore no-console
      console.warn(`${prefix} \u26A0 ${message}`);
    },
    error(message: string): void {
      // deno-lint-ignore no-console
      console.error(`${prefix} \u2717 ${message}`);
    },
    debug(message: string): void {
      if (verbose) {
        // deno-lint-ignore no-console
        console.debug(`${prefix} [debug] ${message}`);
      }
    },
  };
}

// =============================================================================
// Config Loading
// =============================================================================

/** Cached config record to avoid re-reading file multiple times */
let cachedConfigRecord: Record<string, unknown> | null = null;
let cachedConfigPath: string | null = null;

/**
 * Load the current deno.json config as a record for template variables.
 * Results are cached per config path.
 */
async function loadConfigAsRecord(configPath = "deno.json"): Promise<Record<string, unknown>> {
  // Return cached if same path
  if (cachedConfigRecord !== null && cachedConfigPath === configPath) {
    return cachedConfigRecord;
  }

  try {
    const content = await Deno.readTextFile(configPath);
    cachedConfigRecord = JSON.parse(content) as Record<string, unknown>;
    cachedConfigPath = configPath;
    return cachedConfigRecord;
  } catch {
    try {
      const jsoncPath = configPath.replace(/\.json$/, ".jsonc");
      const content = await Deno.readTextFile(jsoncPath);
      // Simple JSONC handling - remove comments
      const cleaned = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      cachedConfigRecord = JSON.parse(cleaned) as Record<string, unknown>;
      cachedConfigPath = jsoncPath;
      return cachedConfigRecord;
    } catch {
      cachedConfigRecord = {};
      cachedConfigPath = configPath;
      return cachedConfigRecord;
    }
  }
}

/**
 * Clear the config cache. Useful for testing.
 */
export function clearConfigCache(): void {
  cachedConfigRecord = null;
  cachedConfigPath = null;
}

// =============================================================================
// Pipeline Execution
// =============================================================================

/**
 * Run the distribution pipeline for a single distribution.
 *
 * @param distName Name of the distribution to build
 * @param config Full distribution configuration
 * @param options Pipeline options
 * @returns Pipeline result
 */
export async function runPipeline(
  distName: string,
  config: DistConfig,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const distConfig = config.distributions[distName];
  if (!distConfig) {
    throw new PipelineError(
      `Distribution "${distName}" not found in configuration`,
      "preprocess",
    );
  }

  const distDir = config.distDir ?? "target";
  const outputDir = join(distDir, distName);
  const sourceDir = Deno.cwd();
  const verbose = options.verbose ?? false;
  const log = createLogFunctions(verbose, distName);

  // Initialize state
  const state: PipelineState = {
    phaseResults: {
      preprocess: undefined,
      transform: undefined,
      postprocess: undefined,
    },
    startTime: Date.now(),
    aborted: false,
  };

  log.info(`Starting pipeline for "${distName}" (runtime: ${distConfig.runtime})`);

  // Clean output directory if requested
  if (options.clean) {
    await cleanOutputDirectory(outputDir, log);
  }

  // Ensure output directory exists
  await ensureDir(outputDir);

  // Create template variables
  const configRecord = await loadConfigAsRecord();
  const variables = createVariablesFromContext(configRecord, options.scope ?? {});

  // Resolve plugins
  const plugins = await resolvePlugins(distConfig.plugins, distConfig);
  log.debug(`Resolved ${plugins.length} plugin(s)`);

  // Create plugin context
  const context: PluginContext = {
    distConfig,
    sourceDir,
    outputDir,
    pluginConfig: {
      options: {},
      verbose,
      workingDir: sourceDir,
    },
    log,
    variables,
  };

  // Run phases sequentially
  const phases: PipelinePhase[] = ["preprocess", "transform", "postprocess"];

  for (const phase of phases) {
    if (state.aborted) break;

    // deno-lint-ignore no-await-in-loop
    const result = await runPhase(phase, plugins, context, log);
    (state.phaseResults as Record<PipelinePhase, PluginPhaseResult | undefined>)[phase] = result;

    if (!result.success) {
      state.aborted = true;
      state.abortReason = `${capitalize(phase)} failed: ${result.error}`;
    }
  }

  const totalDurationMs = Date.now() - state.startTime;
  const success = !state.aborted;

  if (success) {
    log.info(`Pipeline completed successfully in ${totalDurationMs}ms`);
  } else {
    log.error(`Pipeline failed: ${state.abortReason}`);
  }

  return {
    success,
    phases: state.phaseResults,
    totalDurationMs,
    distributionName: distName,
    outputDir,
  };
}

/**
 * Clean the output directory.
 */
async function cleanOutputDirectory(outputDir: string, log: LogFunctions): Promise<void> {
  log.info(`Cleaning output directory: ${outputDir}`);
  try {
    await Deno.remove(outputDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw new PipelineError(
        `Failed to clean output directory: ${String(error)}`,
        "preprocess",
      );
    }
  }
}

/**
 * Capitalize the first letter of a string.
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Run a single pipeline phase across all plugins.
 * Plugins are executed sequentially to maintain order guarantees.
 */
async function runPhase(
  phase: PipelinePhase,
  plugins: readonly ResolvedPlugin[],
  context: PluginContext,
  log: LogFunctions,
): Promise<PluginPhaseResult> {
  log.info(`Starting ${phase} phase...`);

  const startTime = Date.now();
  const allWarnings: string[] = [];
  const allAffectedFiles: string[] = [];

  for (const resolved of plugins) {
    const plugin = resolved.plugin;
    const handler = plugin[phase];

    if (!handler) {
      log.debug(`Plugin "${plugin.metadata.id}" has no ${phase} handler, skipping`);
      continue;
    }

    log.debug(`Running ${phase} for plugin "${plugin.metadata.id}"...`);

    // Create plugin-specific context with its options
    const pluginContext: PluginContext = {
      ...context,
      pluginConfig: {
        ...context.pluginConfig,
        options: resolved.config.options ?? {},
      },
    };

    try {
      // Sequential execution is intentional - plugins may depend on previous results
      // deno-lint-ignore no-await-in-loop
      const result = await handler.call(plugin, pluginContext);

      if (!result.success) {
        log.error(`Plugin "${plugin.metadata.id}" ${phase} failed: ${result.error}`);
        return {
          success: false,
          error: result.error,
          warnings: allWarnings.length > 0 ? allWarnings : undefined,
          durationMs: Date.now() - startTime,
        };
      }

      if (result.warnings) {
        allWarnings.push(...result.warnings);
      }

      if (result.affectedFiles) {
        allAffectedFiles.push(...result.affectedFiles);
      }

      log.debug(
        `Plugin "${plugin.metadata.id}" ${phase} completed in ${result.durationMs ?? 0}ms`,
      );
    } catch (error) {
      log.error(`Plugin "${plugin.metadata.id}" ${phase} threw: ${String(error)}`);
      return {
        success: false,
        error: `Plugin "${plugin.metadata.id}" threw: ${String(error)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(`${capitalize(phase)} phase completed in ${durationMs}ms`);

  return {
    success: true,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    affectedFiles: allAffectedFiles.length > 0 ? allAffectedFiles : undefined,
    durationMs,
  };
}

/**
 * Run the pipeline for all distributions.
 *
 * @param config Full distribution configuration
 * @param options Pipeline options
 * @returns Map of distribution name to pipeline result
 */
export async function runPipelineAll(
  config: DistConfig,
  options: PipelineOptions = {},
): Promise<Map<string, PipelineResult>> {
  const results = new Map<string, PipelineResult>();
  const distNames = Object.keys(config.distributions);

  // deno-lint-ignore no-console
  console.log(`Building ${distNames.length} distribution(s)...`);

  // Run distributions sequentially - they may share resources
  for (const distName of distNames) {
    // deno-lint-ignore no-await-in-loop
    const result = await runPipeline(distName, config, options);
    results.set(distName, result);
  }

  // Summary
  const successful = [...results.values()].filter((r) => r.success).length;
  const failed = results.size - successful;

  // deno-lint-ignore no-console
  console.log(`\nBuild summary: ${successful} succeeded, ${failed} failed`);

  return results;
}
