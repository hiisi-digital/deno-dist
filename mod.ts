/**
 * @module @hiisi/deno-dist
 *
 * Universal distribution tool for Deno projects.
 * Produces runtime-optimized distributions from a single Deno codebase.
 * Supports Deno, Node.js, and Bun as target runtimes.
 *
 * @example
 * ```ts
 * // Use via CLI
 * // deno-dist build node
 * // deno-dist build --all
 * // deno-dist setup --all
 * // deno-dist release node
 * // deno-dist validate
 * ```
 *
 * @example
 * ```ts
 * import {
 *   loadDistConfig,
 *   runPipeline,
 *   validateConfig,
 * } from "@hiisi/deno-dist";
 *
 * // Load distribution configuration from deno.json
 * const config = await loadDistConfig("./deno.json");
 *
 * // Validate the configuration
 * const validation = validateConfig(config);
 * if (!validation.valid) {
 *   console.error("Invalid config:", validation.errors);
 *   Deno.exit(1);
 * }
 *
 * // Build a specific distribution
 * const result = await runPipeline("node", config);
 * if (result.success) {
 *   console.log("Build complete:", result.outputDir);
 * }
 * ```
 */

// =============================================================================
// Generated Types (from JSON schemas)
// =============================================================================

export type {
  BuildPhaseId,
  CiConfig,
  DistConfigSchema,
  DistributionConfigSchema,
  InlinePluginConfig,
  LifecyclePhaseId,
  PhaseId,
  PluginMetadataSchema,
  PluginReference,
  PublishConfig,
  RegistryConfig,
  ReleaseNotesConfig,
  RuntimeId,
  TargetRuntime,
  TestConfig,
} from "./src/generated_types.ts";

export {
  BUILD_PHASE_IDS,
  isBuildPhase,
  isLifecyclePhase,
  isPhaseId,
  isRuntimeId,
  LIFECYCLE_PHASE_IDS,
  PHASE_IDS,
  RUNTIME_IDS,
} from "./src/generated_types.ts";

// =============================================================================
// Core Types
// =============================================================================

export type {
  BasePluginContext,
  CliArgs,
  CliCommand,
  DistConfig,
  DistMetadata,
  DistributionConfig,
  ExecutionGraph,
  ExecutionOperation,
  ExecutionWave,
  FileOperation,
  GraphExecutionResult,
  LogFunctions,
  PipelineOptions,
  PipelinePhase,
  PipelineResult,
  Plugin,
  PluginConfig,
  PluginContext,
  PluginMetadata,
  PluginPhaseResult,
  PostprocessPlugin,
  PreprocessPlugin,
  ReleaseContext,
  ReleasePlugin,
  ReleaseResult,
  RuntimeVersion,
  SetupContext,
  SetupPlugin,
  SetupResult,
  TemplateInsertionMode,
  TemplateMarker,
  TemplateVariables,
  TransformPlugin,
  WorkflowConfig,
  WorkflowJob,
  WorkflowStep,
  WorkflowTriggers,
} from "./src/types.ts";

export {
  ConfigError,
  DistError,
  getPluginPhases,
  GraphError,
  PipelineError,
  PluginError,
  pluginImplementsPhase,
  TemplateError,
} from "./src/types.ts";

// =============================================================================
// Configuration
// =============================================================================

export { loadDistConfig, parseDistConfig, validateConfig } from "./src/config.ts";

export type { ConfigValidationResult } from "./src/config.ts";

// =============================================================================
// Template Processing
// =============================================================================

export {
  createVariables,
  findTemplateMarkers,
  parseVariable,
  processTemplate,
  resolveVariable,
} from "./src/template.ts";

export type { ParsedVariable, VariableType } from "./src/template.ts";

// =============================================================================
// Pipeline
// =============================================================================

export {
  clearConfigCache,
  runBuild,
  runPipeline,
  runPipelineAll,
  runPipelineGraph,
  runRelease,
  runSetup,
} from "./src/pipeline.ts";

export type { ExtendedPipelineOptions } from "./src/pipeline.ts";

// =============================================================================
// Graph Execution
// =============================================================================

export {
  buildExecutionGraph,
  executeGraph,
  filterGraphByPhases,
  getDistributionOperations,
  getPhaseOperations,
  mergeGraphs,
  visualizeGraph,
} from "./src/graph.ts";

export type { ContextFactory, GraphBuildOptions, ResolvedPluginInfo } from "./src/graph.ts";

// =============================================================================
// Plugins
// =============================================================================

export {
  checkPluginConflicts,
  isBuiltinPlugin,
  loadPlugin,
  resolvePlugins,
  validatePlugin,
} from "./src/plugins/mod.ts";

export type { PluginValidationResult, ResolvedPlugin } from "./src/plugins/mod.ts";

// =============================================================================
// Plugin Utilities (for plugin authors)
// =============================================================================

export {
  collectFiles,
  createTimer,
  DEFAULT_COPY_FILES,
  DEFAULT_ENTRY_POINT,
  ensureDirectory,
  escapeRegex,
  failureResult,
  getDirectory,
  getOption,
  getPackageName,
  getPackageVersion,
  getRelativePath,
  matchGlob,
  runCommand,
  runDenoScript,
  successResult,
  transformFiles,
  tryCopyFile,
  validateArray,
  validateBoolean,
  validateDirectoryExists,
  validateFileExists,
  validateOneOf,
  validateRequired,
  validateString,
} from "./src/plugins/utils.ts";

export type {
  CollectFilesOptions,
  CommandResult,
  CopyResult,
  RunCommandOptions,
  TransformFilesOptions,
  ValidationError,
  ValidationResult,
} from "./src/plugins/utils.ts";
