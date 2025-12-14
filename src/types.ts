/**
 * @module types
 *
 * Core type definitions for deno-dist.
 */

// =============================================================================
// Runtime Types
// =============================================================================

/**
 * Supported runtime identifiers.
 */
export type RuntimeId = "deno" | "node" | "bun";

/**
 * Runtime version specification.
 */
export type RuntimeVersion = string;

// =============================================================================
// Plugin System Types
// =============================================================================

/**
 * Plugin metadata for identification and discovery.
 */
export interface PluginMetadata {
  /** Unique plugin identifier (e.g., "deno-to-node", "deno-to-bun") */
  readonly id: string;
  /** Human-readable plugin name */
  readonly name: string;
  /** Plugin version (semver) */
  readonly version: string;
  /** Brief description of what the plugin does */
  readonly description: string;
  /** Target runtime this plugin produces output for */
  readonly targetRuntime: RuntimeId;
  /** Author or maintainer */
  readonly author?: string;
  /** License identifier */
  readonly license?: string;
  /** Repository URL */
  readonly repository?: string;
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
 * Context provided to plugin hooks during execution.
 */
export interface PluginContext {
  /** The distribution configuration being processed */
  readonly distConfig: DistributionConfig;
  /** Source directory (input) */
  readonly sourceDir: string;
  /** Output directory for this distribution */
  readonly outputDir: string;
  /** Plugin-specific configuration */
  readonly pluginConfig: PluginConfig;
  /** Logging functions */
  readonly log: LogFunctions;
  /** Resolved template variables */
  readonly variables: TemplateVariables;
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
}

/**
 * Plugin reference in configuration.
 * Can be a string identifier or an inline plugin configuration.
 */
export type PluginReference = string | InlinePluginConfig;

/**
 * Inline plugin configuration with ordering support.
 */
export interface InlinePluginConfig {
  /** Plugin identifier */
  readonly id: string;
  /** Plugin-specific options */
  readonly options?: Record<string, unknown>;
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
  /** Template file mappings */
  readonly templates?: Record<string, string>;
  /** String replacement patterns */
  readonly replacements?: Record<string, string>;
  /** Test configuration */
  readonly test?: TestConfig;
  /** Publish configuration */
  readonly publish?: PublishConfig;
}

/**
 * Test configuration for a distribution.
 */
export interface TestConfig {
  /** Command to run tests */
  readonly command?: string;
  /** Additional setup commands */
  readonly setup?: readonly string[];
  /** Test timeout in milliseconds */
  readonly timeout?: number;
  /** Environment variables for testing */
  readonly env?: Record<string, string>;
}

/**
 * Publish configuration for a distribution.
 */
export interface PublishConfig {
  /** Registry to publish to (e.g., "npm", "jsr") */
  readonly registry?: string;
  /** Whether to generate provenance */
  readonly provenance?: boolean;
  /** Access level ("public" or "restricted") */
  readonly access?: "public" | "restricted";
  /** Custom publish command */
  readonly command?: string;
}

// =============================================================================
// Template Types
// =============================================================================

/**
 * Template variables available during processing.
 */
export interface TemplateVariables {
  /** Environment variables (@{env.VAR_NAME}) */
  readonly env: Record<string, string>;
  /** Config values (@{config.field}) */
  readonly config: Record<string, unknown>;
  /** CLI-provided scope values (@{scope.key}) */
  readonly scope: Record<string, string>;
  /** Capture variables (@{=varName}) */
  readonly captures: Record<string, string>;
  /** Custom variables (@{customVar}) */
  readonly custom: Record<string, string>;
}

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
// Pipeline Types
// =============================================================================

/**
 * Pipeline phase identifier.
 */
export type PipelinePhase = "preprocess" | "transform" | "postprocess";

/**
 * Result of a complete pipeline execution.
 */
export interface PipelineResult {
  /** Whether the entire pipeline succeeded */
  readonly success: boolean;
  /** Results from each phase */
  readonly phases: Record<PipelinePhase, PluginPhaseResult | undefined>;
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
  readonly pull_request?: { branches?: readonly string[] };
  readonly workflow_dispatch?: Record<string, unknown>;
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
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "DistError";
  }
}

/**
 * Configuration validation error.
 */
export class ConfigError extends DistError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

/**
 * Plugin-related error.
 */
export class PluginError extends DistError {
  constructor(
    message: string,
    public readonly pluginId: string,
  ) {
    super(message, "PLUGIN_ERROR");
    this.name = "PluginError";
  }
}

/**
 * Template processing error.
 */
export class TemplateError extends DistError {
  constructor(message: string) {
    super(message, "TEMPLATE_ERROR");
    this.name = "TemplateError";
  }
}

/**
 * Pipeline execution error.
 */
export class PipelineError extends DistError {
  constructor(
    message: string,
    public readonly phase: PipelinePhase,
  ) {
    super(message, "PIPELINE_ERROR");
    this.name = "PipelineError";
  }
}
