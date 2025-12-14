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
 * // deno task dist build node
 * // deno task dist build --all
 * // deno task dist validate
 * // deno task dist update-workflows
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
// Core Types
// =============================================================================

export type {
  CliArgs,
  CliCommand,
  DistConfig,
  DistributionConfig,
  InlinePluginConfig,
  LogFunctions,
  PipelineOptions,
  PipelinePhase,
  PipelineResult,
  Plugin,
  PluginConfig,
  PluginContext,
  PluginMetadata,
  PluginPhaseResult,
  PluginReference,
  PostprocessPlugin,
  PreprocessPlugin,
  PublishConfig,
  RuntimeId,
  RuntimeVersion,
  TemplateInsertionMode,
  TemplateMarker,
  TemplateVariables,
  TestConfig,
  TransformPlugin,
  WorkflowConfig,
  WorkflowJob,
  WorkflowStep,
  WorkflowTriggers,
} from "./src/types.ts";

export { ConfigError, DistError, PipelineError, PluginError, TemplateError } from "./src/types.ts";

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

export { clearConfigCache, runPipeline, runPipelineAll } from "./src/pipeline.ts";

// =============================================================================
// Plugins
// =============================================================================

export { loadPlugin, resolvePlugins } from "./src/plugins/mod.ts";

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
