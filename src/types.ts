/**
 * @module types
 *
 * Core type definitions for deno-dist.
 * This module defines all types for the plugin system, pipeline execution,
 * and configuration.
 */

// Re-export generated schema types
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
} from "./generated_types.ts";

export {
  BUILD_PHASE_IDS,
  isBuildPhase,
  isLifecyclePhase,
  isPhaseId,
  isRuntimeId,
  LIFECYCLE_PHASE_IDS,
  PHASE_IDS,
  RUNTIME_IDS,
} from "./generated_types.ts";

import type {
  BuildPhaseId,
  CiConfig,
  InlinePluginConfig,
  PhaseId,
  PluginMetadataSchema,
  PluginReference,
  PublishConfig,
  ReleaseNotesConfig,
  RuntimeId,
  TargetRuntime,
  TestConfig,
} from "./generated_types.ts";

// =============================================================================
// Runtime Types
// =============================================================================

/**
 * Runtime version specification.
 */
export type RuntimeVersion = string;

// =============================================================================
// Plugin System Types
// =============================================================================

/**
 * Extended plugin metadata with runtime validation.
 * This extends the schema-generated metadata with computed properties.
 */
export interface PluginMetadata extends PluginMetadataSchema {
  /** Unique plugin identifier (e.g., "deno-to-node", "deno-to-bun") */
  readonly id: string;
  /** Human-readable plugin name */
  readonly name: string;
  /** Plugin version (semver) */
  readonly version: string;
  /** Brief description of what the plugin does */
  readonly description: string;
  /** Target runtime this plugin produces output for, or 'any' for lifecycle-only plugins */
  readonly targetRuntime: TargetRuntime;
}

/**
 * Plugin configuration options passed at runtime.
 */
export interface PluginConfig {
  /** Plugin-specific options */
  readonly options?: Record<string, unknown>;
  /** Whether to enable verbose logging */
  readonly verbose?: boolean;
  /** Working directory for plugin operations */
  readonly workingDir?: string;
}

/**
 * Logging functions available to plugins.
 */
export interface LogFunctions {
  /** Log an info message */
  info(message: string): void;
  /** Log a warning message */
  warn(message: string): void;
  /** Log an error message */
  error(message: string): void;
  /** Log a debug message (only shown in verbose mode) */
  debug(message: string): void;
}

/**
 * Template variables available during processing.
 *
 * Variables are resolved in this order:
 * 1. Capture variables (@{=name}) - from pattern matching
 * 2. Environment variables (@{env.VAR}) - from Deno.env
 * 3. Config variables (@{config.field}) - from deno.json
 * 4. Custom variables (@{varName}) - from CLI --scope or metadata.dist.scope
 */
export interface TemplateVariables {
  /** Environment variables (@{env.VAR_NAME}) */
  readonly env: Record<string, string>;
  /** Config values (@{config.field}) */
  readonly config: Record<string, unknown>;
  /** Capture variables (@{=varName}) - from pattern matching */
  readonly captures: Record<string, string>;
  /** Custom variables (@{varName}) - from CLI --scope or metadata.dist.scope */
  readonly custom: Record<string, string>;
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Base context provided to all plugin phases.
 */
export interface BasePluginContext {
  /** Source directory (input) */
  readonly sourceDir: string;
  /** Plugin-specific configuration */
  readonly pluginConfig: PluginConfig;
  /** Logging functions */
  readonly log: LogFunctions;
  /** Resolved template variables */
  readonly variables: TemplateVariables;
  /** Whether this is a dry run (no actual changes) */
  readonly dryRun: boolean;
}

/**
 * Context provided to build phase plugins (preprocess, transform, postprocess).
 */
export interface PluginContext extends BasePluginContext {
  /** The distribution configuration being processed */
  readonly distConfig: DistributionConfig;
  /** Output directory for this distribution */
  readonly outputDir: string;
}

/**
 * Context provided to setup phase plugins.
 */
export interface SetupContext extends BasePluginContext {
  /** The distribution configuration being processed */
  readonly distConfig: DistributionConfig;
  /** All distribution configurations (for generating combined workflows) */
  readonly allDistConfigs: DistConfig;
  /** Target file paths for generated files */
  readonly outputPaths: {
    /** Workflows directory (e.g., ".github/workflows") */
    readonly workflowsDir: string;
  };
}

/**
 * Context provided to release phase plugins.
 */
export interface ReleaseContext extends BasePluginContext {
  /** The distribution configuration being processed */
  readonly distConfig: DistributionConfig;
  /** Output directory containing the built distribution */
  readonly outputDir: string;
  /** Package version being released */
  readonly version: string;
  /** Release notes content (if generated) */
  readonly releaseNotes?: string;
  /** Previous version (for changelog generation) */
  readonly previousVersion?: string;
  /** Git tag for this release */
  readonly tag?: string;
}

// =============================================================================
// Result Types
// =============================================================================

/**
 * Result of a plugin phase execution.
 */
export interface PluginPhaseResult {
  /** Whether the phase completed successfully */
  readonly success: boolean;
  /** Error message if unsuccessful */
  readonly error?: string;
  /** Warnings generated during execution */
  readonly warnings?: readonly string[];
  /** Files that were created or modified */
  readonly affectedFiles?: readonly string[];
  /** Duration of the phase in milliseconds */
  readonly durationMs?: number;
}

/**
 * File operation for setup phase.
 */
export interface FileOperation {
  /** File path relative to project root */
  readonly path: string;
  /** File content */
  readonly content: string;
  /** Operation type */
  readonly action: "create" | "update" | "delete";
}

/**
 * Result of a setup phase execution.
 */
export interface SetupResult extends PluginPhaseResult {
  /** File operations performed */
  readonly files?: readonly FileOperation[];
}

/**
 * Result of a release phase execution.
 */
export interface ReleaseResult extends PluginPhaseResult {
  /** Registry that was published to */
  readonly registry?: string;
  /** Version that was published */
  readonly publishedVersion?: string;
  /** URL to the published package */
  readonly url?: string;
  /** Release assets that were uploaded */
  readonly assets?: readonly string[];
}

// =============================================================================
// Plugin Interface
// =============================================================================

/**
 * Plugin interface for preprocess phase.
 * Runs before the main transform, used for setup and preparation.
 */
export interface PreprocessPlugin {
  /** Plugin metadata */
  readonly metadata: PluginMetadata;
  /**
   * Execute the preprocess phase.
   * @param context Plugin execution context
   * @returns Result of the phase execution
   */
  preprocess(context: PluginContext): Promise<PluginPhaseResult>;
}

/**
 * Plugin interface for transform phase.
 * The main conversion logic (e.g., deno-to-node transformation).
 */
export interface TransformPlugin {
  /** Plugin metadata */
  readonly metadata: PluginMetadata;
  /**
   * Execute the transform phase.
   * @param context Plugin execution context
   * @returns Result of the phase execution
   */
  transform(context: PluginContext): Promise<PluginPhaseResult>;
}

/**
 * Plugin interface for postprocess phase.
 * Runs after transform, used for cleanup and optimization.
 */
export interface PostprocessPlugin {
  /** Plugin metadata */
  readonly metadata: PluginMetadata;
  /**
   * Execute the postprocess phase.
   * @param context Plugin execution context
   * @returns Result of the phase execution
   */
  postprocess(context: PluginContext): Promise<PluginPhaseResult>;
}

/**
 * Plugin interface for setup phase.
 * Generates project files like CI workflows.
 */
export interface SetupPlugin {
  /** Plugin metadata */
  readonly metadata: PluginMetadata;
  /**
   * Execute the setup phase.
   * @param context Setup execution context
   * @returns Result of the phase execution
   */
  setup(context: SetupContext): Promise<SetupResult>;
}

/**
 * Plugin interface for release phase.
 * Handles publishing to registries.
 */
export interface ReleasePlugin {
  /** Plugin metadata */
  readonly metadata: PluginMetadata;
  /**
   * Execute the release phase.
   * @param context Release execution context
   * @returns Result of the phase execution
   */
  release(context: ReleaseContext): Promise<ReleaseResult>;
}

/**
 * Full plugin interface implementing all phases.
 * Plugins may implement any subset of phases.
 */
export interface Plugin {
  /** Plugin metadata */
  readonly metadata: PluginMetadata;
  /** Preprocess phase (optional) */
  preprocess?(context: PluginContext): Promise<PluginPhaseResult>;
  /** Transform phase (optional) */
  transform?(context: PluginContext): Promise<PluginPhaseResult>;
  /** Postprocess phase (optional) */
  postprocess?(context: PluginContext): Promise<PluginPhaseResult>;
  /** Setup phase (optional) */
  setup?(context: SetupContext): Promise<SetupResult>;
  /** Release phase (optional) */
  release?(context: ReleaseContext): Promise<ReleaseResult>;
}

/**
 * Type guard to check if a plugin implements a specific phase.
 */
export function pluginImplementsPhase(plugin: Plugin, phase: PhaseId): boolean {
  return typeof plugin[phase] === "function";
}

/**
 * Get the list of phases a plugin implements.
 */
export function getPluginPhases(plugin: Plugin): readonly PhaseId[] {
  const phases: PhaseId[] = [];
  if (plugin.preprocess) phases.push("preprocess");
  if (plugin.transform) phases.push("transform");
  if (plugin.postprocess) phases.push("postprocess");
  if (plugin.setup) phases.push("setup");
  if (plugin.release) phases.push("release");
  return phases;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Root-level distribution configuration in deno.json.
 */
export interface DistConfig {
  /** Output directory for all distributions (default: "target") */
  readonly distDir?: string;
  /** Named distribution configurations */
  readonly distributions: Record<string, DistributionConfig>;
  /** Package metadata */
  readonly metadata?: DistMetadata;
}

/**
 * Dist-specific metadata.
 */
export interface DistMetadata {
  /** Custom template variables available as @{varName} */
  readonly scope?: Record<string, string>;
  /** Default plugins to apply to all distributions */
  readonly defaultPlugins?: readonly string[];
  /** CI configuration */
  readonly ci?: CiConfig;
}

/**
 * Configuration for a single distribution target.
 */
export interface DistributionConfig {
  /** Target runtime identifier */
  readonly runtime: RuntimeId;
  /** Runtime versions to test against */
  readonly versions?: readonly RuntimeVersion[];
  /** Plugins to apply (use "@this" for custom script ordering) */
  readonly plugins?: readonly PluginReference[];
  /** Path to custom preprocess script */
  readonly preprocess?: string;
  /** Path to custom transform script */
  readonly transform?: string;
  /** Path to custom postprocess script */
  readonly postprocess?: string;
  /** Path to custom setup script */
  readonly setup?: string;
  /** Path to custom release script */
  readonly release?: string;
  /** Template file mappings */
  readonly templates?: Record<string, string>;
  /** String replacement patterns */
  readonly replacements?: Record<string, string>;
  /** Test configuration */
  readonly test?: TestConfig;
  /** Publish configuration */
  readonly publish?: PublishConfig;
  /** Release notes configuration */
  readonly releaseNotes?: ReleaseNotesConfig;
}

// =============================================================================
// Pipeline Types
// =============================================================================

/**
 * Pipeline phase identifier (for backwards compatibility).
 * @deprecated Use PhaseId from generated_types instead
 */
export type PipelinePhase = BuildPhaseId;

/**
 * Result of a complete pipeline execution.
 */
export interface PipelineResult {
  /** Whether the entire pipeline succeeded */
  readonly success: boolean;
  /** Results from each phase */
  readonly phases: Partial<Record<PhaseId, PluginPhaseResult>>;
  /** Total duration in milliseconds */
  readonly totalDurationMs: number;
  /** Distribution name that was built */
  readonly distributionName: string;
  /** Output directory */
  readonly outputDir: string;
}

/**
 * Options for running the pipeline.
 */
export interface PipelineOptions {
  /** Whether to run in verbose mode */
  readonly verbose?: boolean;
  /** Whether to skip tests after build */
  readonly skipTests?: boolean;
  /** Custom variables to inject */
  readonly scope?: Record<string, string>;
  /** Whether to clean output directory before build */
  readonly clean?: boolean;
  /** Whether to perform a dry run */
  readonly dryRun?: boolean;
  /** Specific phases to run (if not specified, runs all applicable phases) */
  readonly phases?: readonly PhaseId[];
}

// =============================================================================
// Graph Execution Types
// =============================================================================

/**
 * An operation in the execution graph.
 */
export interface ExecutionOperation {
  /** Unique operation ID */
  readonly id: string;
  /** Plugin to execute */
  readonly plugin: Plugin;
  /** Phase to execute */
  readonly phase: PhaseId;
  /** Distribution name */
  readonly distribution: string;
  /** Plugin configuration */
  readonly config: InlinePluginConfig;
}

/**
 * A wave of operations that can execute in parallel.
 */
export interface ExecutionWave {
  /** Wave index (0-based) */
  readonly index: number;
  /** Operations in this wave */
  readonly operations: readonly ExecutionOperation[];
}

/**
 * The complete execution graph.
 */
export interface ExecutionGraph {
  /** Waves of parallel operations, executed sequentially */
  readonly waves: readonly ExecutionWave[];
  /** Total number of operations */
  readonly totalOperations: number;
  /** Whether the graph has any cycles (should always be false) */
  readonly hasCycles: boolean;
  /** Dependency edges for debugging */
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

/**
 * Result of graph execution.
 */
export interface GraphExecutionResult {
  /** Whether all operations succeeded */
  readonly success: boolean;
  /** Results by operation ID */
  readonly results: ReadonlyMap<string, PluginPhaseResult>;
  /** Operations that failed */
  readonly failed: readonly string[];
  /** Total duration in milliseconds */
  readonly totalDurationMs: number;
}

// =============================================================================
// Template Types
// =============================================================================

/**
 * Template insertion mode.
 */
export type TemplateInsertionMode = "single" | "range";

/**
 * Parsed template marker from source file.
 */
export interface TemplateMarker {
  /** Template name */
  readonly name: string;
  /** Insertion mode */
  readonly mode: TemplateInsertionMode;
  /** Position in source (for single) or start position (for range) */
  readonly startIndex: number;
  /** End position (for range mode) */
  readonly endIndex?: number;
  /** The full matched marker text */
  readonly markerText: string;
}

// =============================================================================
// Workflow Types
// =============================================================================

/**
 * GitHub Actions workflow configuration.
 */
export interface WorkflowConfig {
  /** Workflow name */
  readonly name: string;
  /** Trigger events */
  readonly on: WorkflowTriggers;
  /** Jobs in the workflow */
  readonly jobs: Record<string, WorkflowJob>;
}

/**
 * Workflow trigger configuration.
 */
export interface WorkflowTriggers {
  readonly push?: { branches?: readonly string[]; tags?: readonly string[] };
  readonly "pull_request"?: { branches?: readonly string[] };
  readonly "workflow_dispatch"?: Record<string, unknown>;
  readonly release?: { types?: readonly string[] };
}

/**
 * Workflow job configuration.
 */
export interface WorkflowJob {
  readonly name?: string;
  readonly "runs-on": string;
  readonly strategy?: {
    readonly matrix?: Record<string, readonly unknown[]>;
    readonly "fail-fast"?: boolean;
  };
  readonly steps: readonly WorkflowStep[];
  readonly permissions?: Record<string, string>;
  readonly needs?: readonly string[];
  readonly if?: string;
}

/**
 * Workflow step configuration.
 */
export interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
  readonly if?: string;
  readonly id?: string;
}

// =============================================================================
// CLI Types
// =============================================================================

/**
 * CLI command definition.
 */
export interface CliCommand {
  /** Command name */
  readonly name: string;
  /** Command description */
  readonly description: string;
  /** Command aliases */
  readonly aliases?: readonly string[];
  /** Command handler */
  handler(args: CliArgs): Promise<number>;
}

/**
 * Parsed CLI arguments.
 */
export interface CliArgs {
  /** The command being run */
  readonly command: string;
  /** Positional arguments */
  readonly positional: readonly string[];
  /** Named flags and options */
  readonly flags: Record<string, string | boolean>;
  /** Scope variables from --scope */
  readonly scope: Record<string, string>;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Base error class for deno-dist errors.
 */
export class DistError extends Error {
  override readonly name: string = "DistError";

  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Configuration validation error.
 */
export class ConfigError extends DistError {
  override readonly name: string = "ConfigError";

  constructor(message: string) {
    super(message, "CONFIG_ERROR");
  }
}

/**
 * Plugin-related error.
 */
export class PluginError extends DistError {
  override readonly name: string = "PluginError";

  constructor(
    message: string,
    public readonly pluginId: string,
  ) {
    super(message, "PLUGIN_ERROR");
  }
}

/**
 * Template processing error.
 */
export class TemplateError extends DistError {
  override readonly name: string = "TemplateError";

  constructor(message: string) {
    super(message, "TEMPLATE_ERROR");
  }
}

/**
 * Pipeline execution error.
 */
export class PipelineError extends DistError {
  override readonly name: string = "PipelineError";

  constructor(
    message: string,
    public readonly phase: PhaseId,
  ) {
    super(message, "PIPELINE_ERROR");
  }
}

/**
 * Graph execution error.
 */
export class GraphError extends DistError {
  override readonly name: string = "GraphError";

  constructor(
    message: string,
    public readonly operationId?: string,
  ) {
    super(message, "GRAPH_ERROR");
  }
}
