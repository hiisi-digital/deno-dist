/**
 * @module pipeline
 *
 * Pipeline orchestrator for running plugin phases.
 * Uses a graph-based execution engine for parallel execution where possible.
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { BUILD_PHASE_IDS, LIFECYCLE_PHASE_IDS } from "./generated_types.ts";
import {
  buildExecutionGraph,
  type ContextFactory,
  executeGraph,
  type GraphBuildOptions,
  type ResolvedPluginInfo,
  visualizeGraph,
} from "./graph.ts";
import type { ResolvedPlugin } from "./plugins/mod.ts";
import { resolvePlugins } from "./plugins/mod.ts";
import { createVariablesFromContext } from "./template.ts";
import type {
  DistConfig,
  ExecutionOperation,
  LogFunctions,
  PhaseId,
  PipelineOptions,
  PipelineResult,
  PluginContext,
  PluginPhaseResult,
  ReleaseContext,
  SetupContext,
  TemplateVariables,
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
  readonly phaseResults: Partial<Record<PhaseId, PluginPhaseResult>>;
  /** Start time */
  readonly startTime: number;
  /** Whether the pipeline has been aborted */
  aborted: boolean;
  /** Abort reason */
  abortReason?: string;
}

/**
 * Extended pipeline options for new phases.
 */
export interface ExtendedPipelineOptions extends PipelineOptions {
  /** Whether to run setup phases */
  readonly runSetup?: boolean;
  /** Whether to run release phases */
  readonly runRelease?: boolean;
  /** Package version for release */
  readonly version?: string;
  /** Release notes content */
  readonly releaseNotes?: string;
  /** Previous version for changelog */
  readonly previousVersion?: string;
  /** Git tag */
  readonly tag?: string;
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

/**
 * Create a global logger (not distribution-specific).
 */
function createGlobalLogger(verbose: boolean): LogFunctions {
  return {
    info(message: string): void {
      // deno-lint-ignore no-console
      console.log(`[deno-dist] ${message}`);
    },
    warn(message: string): void {
      // deno-lint-ignore no-console
      console.warn(`[deno-dist] \u26A0 ${message}`);
    },
    error(message: string): void {
      // deno-lint-ignore no-console
      console.error(`[deno-dist] \u2717 ${message}`);
    },
    debug(message: string): void {
      if (verbose) {
        // deno-lint-ignore no-console
        console.debug(`[deno-dist] [debug] ${message}`);
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
// Context Factory
// =============================================================================

/**
 * Create a context factory for the pipeline.
 */
function createContextFactory(
  config: DistConfig,
  options: ExtendedPipelineOptions,
  variables: TemplateVariables,
  loggers: Map<string, LogFunctions>,
): ContextFactory {
  const distDir = config.distDir ?? "target";
  const sourceDir = Deno.cwd();
  const verbose = options.verbose ?? false;
  const dryRun = options.dryRun ?? false;

  return {
    createPluginContext(operation: ExecutionOperation): PluginContext {
      const distConfig = config.distributions[operation.distribution];
      const outputDir = join(distDir, operation.distribution);
      const log = loggers.get(operation.distribution) ??
        createLogFunctions(verbose, operation.distribution);

      return {
        distConfig,
        sourceDir,
        outputDir,
        pluginConfig: {
          options: operation.config.options ?? {},
          verbose,
          workingDir: sourceDir,
        },
        log,
        variables,
        dryRun,
      };
    },

    createSetupContext(operation: ExecutionOperation): SetupContext {
      const distConfig = config.distributions[operation.distribution];
      const log = loggers.get(operation.distribution) ??
        createLogFunctions(verbose, operation.distribution);

      // Determine workflows directory based on CI config
      const ciConfig = config.metadata?.ci;
      const provider = ciConfig?.provider ?? "github";
      const workflowsDir = ciConfig?.workflowsDir ?? getDefaultWorkflowsDir(provider);

      return {
        distConfig,
        allDistConfigs: config,
        sourceDir,
        pluginConfig: {
          options: operation.config.options ?? {},
          verbose,
          workingDir: sourceDir,
        },
        log,
        variables,
        dryRun,
        outputPaths: {
          workflowsDir,
        },
      };
    },

    createReleaseContext(operation: ExecutionOperation): ReleaseContext {
      const distConfig = config.distributions[operation.distribution];
      const outputDir = join(distDir, operation.distribution);
      const log = loggers.get(operation.distribution) ??
        createLogFunctions(verbose, operation.distribution);

      return {
        distConfig,
        sourceDir,
        outputDir,
        pluginConfig: {
          options: operation.config.options ?? {},
          verbose,
          workingDir: sourceDir,
        },
        log,
        variables,
        dryRun,
        version: options.version ?? "0.0.0",
        releaseNotes: options.releaseNotes,
        previousVersion: options.previousVersion,
        tag: options.tag,
      };
    },
  };
}

/**
 * Get the default workflows directory for a CI provider.
 */
function getDefaultWorkflowsDir(provider: string): string {
  switch (provider) {
    case "github":
      return ".github/workflows";
    case "gitlab":
      return ".gitlab-ci";
    case "codeberg":
      return ".woodpecker";
    default:
      return ".ci";
  }
}

// =============================================================================
// Pipeline Execution (Legacy API)
// =============================================================================

/**
 * Run the distribution pipeline for a single distribution.
 * This is the legacy API that runs only build phases.
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
    phaseResults: {},
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
    dryRun: options.dryRun ?? false,
  };

  // Run build phases sequentially (legacy behavior)
  const phases: PhaseId[] = ["preprocess", "transform", "postprocess"];

  for (const phase of phases) {
    if (state.aborted) break;

    // deno-lint-ignore no-await-in-loop
    const result = await runPhase(phase, plugins, context, log);
    (state.phaseResults as Record<PhaseId, PluginPhaseResult>)[phase] = result;

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
  phase: PhaseId,
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
      const result = await (handler as (context: PluginContext) => Promise<PluginPhaseResult>).call(
        plugin,
        pluginContext,
      );

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

// =============================================================================
// Graph-Based Pipeline Execution (New API)
// =============================================================================

/**
 * Run the pipeline using the graph-based execution engine.
 * This enables parallel execution where possible.
 *
 * @param config Full distribution configuration
 * @param options Extended pipeline options
 * @returns Map of distribution name to pipeline result
 */
export async function runPipelineGraph(
  config: DistConfig,
  options: ExtendedPipelineOptions = {},
): Promise<Map<string, PipelineResult>> {
  const verbose = options.verbose ?? false;
  const log = createGlobalLogger(verbose);
  const distNames = Object.keys(config.distributions);

  log.info(`Building ${distNames.length} distribution(s) using graph execution...`);

  // Resolve all plugins for all distributions
  const allPlugins: ResolvedPluginInfo[] = [];
  const loggers = new Map<string, LogFunctions>();

  for (const distName of distNames) {
    const distConfig = config.distributions[distName];
    const distLog = createLogFunctions(verbose, distName);
    loggers.set(distName, distLog);

    // Clean output directory if requested
    if (options.clean) {
      const distDir = config.distDir ?? "target";
      const outputDir = join(distDir, distName);
      // deno-lint-ignore no-await-in-loop
      await cleanOutputDirectory(outputDir, distLog);
    }

    // Ensure output directory exists
    const distDir = config.distDir ?? "target";
    const outputDir = join(distDir, distName);
    // deno-lint-ignore no-await-in-loop
    await ensureDir(outputDir);

    // deno-lint-ignore no-await-in-loop
    const plugins = await resolvePlugins(distConfig.plugins, distConfig);

    for (const resolved of plugins) {
      allPlugins.push({
        plugin: resolved.plugin,
        config: resolved.config,
        distribution: distName,
      });
    }
  }

  // Create template variables
  const configRecord = await loadConfigAsRecord();
  const variables = createVariablesFromContext(configRecord, options.scope ?? {});

  // Build the execution graph
  const graphOptions: GraphBuildOptions = {
    distributions: distNames,
    includeSetup: options.runSetup ?? false,
    includeRelease: options.runRelease ?? false,
    phases: options.phases,
  };

  const graph = buildExecutionGraph(allPlugins, graphOptions);

  if (verbose) {
    log.debug("\n" + visualizeGraph(graph));
  }

  log.info(`Execution graph: ${graph.totalOperations} operations in ${graph.waves.length} waves`);

  // Create context factory
  const contextFactory = createContextFactory(config, options, variables, loggers);

  // Execute the graph
  const graphResult = await executeGraph(
    graph,
    config,
    contextFactory,
    (completed, total, operation) => {
      if (verbose) {
        log.debug(`Progress: ${completed}/${total} - Completed ${operation.id}`);
      }
    },
  );

  // Convert graph results to pipeline results
  const results = new Map<string, PipelineResult>();

  for (const distName of distNames) {
    const distDir = config.distDir ?? "target";
    const outputDir = join(distDir, distName);

    // Collect phase results for this distribution
    const phaseResults: Partial<Record<PhaseId, PluginPhaseResult>> = {};
    let distSuccess = true;
    let totalDuration = 0;

    for (const phase of [...BUILD_PHASE_IDS, ...LIFECYCLE_PHASE_IDS]) {
      // Find all results for this distribution and phase
      const phaseOps = graph.waves.flatMap((w) =>
        w.operations.filter(
          (op) => op.distribution === distName && op.phase === phase,
        )
      );

      if (phaseOps.length === 0) continue;

      const phaseOpResults = phaseOps.map((op) => graphResult.results.get(op.id));
      const phaseSuccess = phaseOpResults.every((r) => r?.success ?? false);
      const phaseWarnings = phaseOpResults.flatMap((r) => r?.warnings ?? []);
      const phaseAffectedFiles = phaseOpResults.flatMap((r) => r?.affectedFiles ?? []);
      const phaseDuration = phaseOpResults.reduce(
        (sum, r) => sum + (r?.durationMs ?? 0),
        0,
      );

      totalDuration += phaseDuration;

      phaseResults[phase] = {
        success: phaseSuccess,
        warnings: phaseWarnings.length > 0 ? phaseWarnings : undefined,
        affectedFiles: phaseAffectedFiles.length > 0 ? phaseAffectedFiles : undefined,
        durationMs: phaseDuration,
        error: phaseOpResults.find((r) => !r?.success)?.error,
      };

      if (!phaseSuccess) {
        distSuccess = false;
      }
    }

    results.set(distName, {
      success: distSuccess,
      phases: phaseResults,
      totalDurationMs: totalDuration,
      distributionName: distName,
      outputDir,
    });
  }

  // Summary
  const successful = [...results.values()].filter((r) => r.success).length;
  const failed = results.size - successful;

  log.info(`\nBuild summary: ${successful} succeeded, ${failed} failed`);
  log.info(`Total graph execution time: ${graphResult.totalDurationMs}ms`);

  return results;
}

// =============================================================================
// Specialized Phase Runners
// =============================================================================

/**
 * Run only setup phases for all distributions.
 */
export function runSetup(
  config: DistConfig,
  options: ExtendedPipelineOptions = {},
): Promise<Map<string, PipelineResult>> {
  return runPipelineGraph(config, {
    ...options,
    runSetup: true,
    runRelease: false,
    phases: ["setup"],
  });
}

/**
 * Run only release phases for all distributions.
 */
export function runRelease(
  config: DistConfig,
  options: ExtendedPipelineOptions = {},
): Promise<Map<string, PipelineResult>> {
  // Release requires build phases to have been run first
  // For now, we run all build phases plus release
  return runPipelineGraph(config, {
    ...options,
    runSetup: false,
    runRelease: true,
    phases: ["preprocess", "transform", "postprocess", "release"],
  });
}

/**
 * Run build phases only (preprocess, transform, postprocess).
 */
export function runBuild(
  config: DistConfig,
  options: ExtendedPipelineOptions = {},
): Promise<Map<string, PipelineResult>> {
  return runPipelineGraph(config, {
    ...options,
    runSetup: false,
    runRelease: false,
    phases: ["preprocess", "transform", "postprocess"],
  });
}
