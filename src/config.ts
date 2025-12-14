/**
 * @module config
 *
 * Configuration loading, parsing, and validation for deno-dist.
 */

import { parse as parseJsonc } from "@std/jsonc";
import type {
  DistConfig,
  DistributionConfig,
  PluginReference,
  PublishConfig,
  RuntimeId,
  TestConfig,
} from "./types.ts";
import { ConfigError } from "./types.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of configuration validation.
 */
export interface ConfigValidationResult {
  /** Whether the configuration is valid */
  readonly valid: boolean;
  /** Validation error messages */
  readonly errors: readonly string[];
  /** Validation warning messages */
  readonly warnings: readonly string[];
}

/**
 * Raw deno.json structure (partial, focusing on dist-related fields).
 */
interface RawDenoJson {
  name?: string;
  version?: string;
  dist?: RawDistConfig;
  distDir?: string;
}

/**
 * Raw dist configuration from deno.json.
 */
interface RawDistConfig {
  [key: string]: unknown;
}

// =============================================================================
// Constants
// =============================================================================

const VALID_RUNTIMES: readonly RuntimeId[] = ["deno", "node", "bun"];
const DEFAULT_DIST_DIR = "target";

// =============================================================================
// Type Guards & Helpers
// =============================================================================

/**
 * Check if a value is a non-null object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check if a value is a valid runtime identifier.
 */
function isValidRuntime(value: unknown): value is RuntimeId {
  return typeof value === "string" && VALID_RUNTIMES.includes(value as RuntimeId);
}

/**
 * Safely convert a value to string if defined.
 */
function toOptionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Parse a value as an array of strings.
 */
function toStringArray(value: unknown, fieldName: string): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(`${fieldName} must be an array`);
  }
  return value.map(String);
}

/**
 * Parse a value as a Record<string, string>.
 */
function toStringRecord(value: unknown, fieldName: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new ConfigError(`${fieldName} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    result[k] = String(v);
  }
  return result;
}

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Load distribution configuration from a deno.json file.
 *
 * @param path Path to deno.json file
 * @returns Parsed distribution configuration
 * @throws ConfigError if file cannot be read or parsed
 */
export async function loadDistConfig(path: string): Promise<DistConfig> {
  try {
    const content = await Deno.readTextFile(path);
    return parseDistConfig(content, path);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    if (error instanceof Deno.errors.NotFound) {
      throw new ConfigError(`Configuration file not found: ${path}`);
    }
    throw new ConfigError(
      `Failed to read configuration file: ${path} - ${String(error)}`,
    );
  }
}

/**
 * Parse distribution configuration from JSON/JSONC content.
 *
 * @param content JSON or JSONC content
 * @param sourcePath Optional source path for error messages
 * @returns Parsed distribution configuration
 * @throws ConfigError if content cannot be parsed
 */
export function parseDistConfig(content: string, sourcePath?: string): DistConfig {
  let raw: RawDenoJson;
  try {
    raw = parseJsonc(content) as RawDenoJson;
  } catch (error) {
    const source = sourcePath ? ` in ${sourcePath}` : "";
    throw new ConfigError(`Invalid JSON${source}: ${String(error)}`);
  }

  if (!isObject(raw)) {
    throw new ConfigError("Configuration must be an object");
  }

  const distDir = typeof raw.distDir === "string" ? raw.distDir : DEFAULT_DIST_DIR;
  const distributions = parseDistributions(raw.dist as RawDistConfig | undefined);

  return { distDir, distributions };
}

/**
 * Parse distribution configurations from raw dist object.
 */
function parseDistributions(
  raw: RawDistConfig | undefined,
): Record<string, DistributionConfig> {
  if (!isObject(raw)) {
    return {};
  }

  const distributions: Record<string, DistributionConfig> = {};

  for (const [name, value] of Object.entries(raw)) {
    if (isObject(value)) {
      distributions[name] = parseDistributionConfig(name, value);
    }
  }

  return distributions;
}

/**
 * Parse a single distribution configuration.
 */
function parseDistributionConfig(
  name: string,
  raw: Record<string, unknown>,
): DistributionConfig {
  return {
    runtime: parseRuntime(raw.runtime, name),
    versions: toStringArray(raw.versions, "versions"),
    plugins: parsePlugins(raw.plugins),
    preprocess: toOptionalString(raw.preprocess),
    transform: toOptionalString(raw.transform),
    postprocess: toOptionalString(raw.postprocess),
    templates: toStringRecord(raw.templates, "templates"),
    replacements: toStringRecord(raw.replacements, "replacements"),
    test: parseTestConfig(raw.test),
    publish: parsePublishConfig(raw.publish),
  };
}

/**
 * Parse runtime identifier.
 */
function parseRuntime(value: unknown, distName: string): RuntimeId {
  if (typeof value !== "string") {
    throw new ConfigError(
      `Distribution "${distName}" must have a "runtime" field`,
    );
  }
  if (!isValidRuntime(value)) {
    throw new ConfigError(
      `Distribution "${distName}" has invalid runtime "${value}". ` +
        `Valid runtimes: ${VALID_RUNTIMES.join(", ")}`,
    );
  }
  return value;
}

/**
 * Parse plugins array.
 */
function parsePlugins(value: unknown): readonly PluginReference[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ConfigError("plugins must be an array");
  }
  return value.map(parsePluginReference);
}

/**
 * Parse a single plugin reference.
 */
function parsePluginReference(value: unknown): PluginReference {
  if (typeof value === "string") {
    return value;
  }
  if (isObject(value) && "id" in value) {
    return {
      id: String(value.id),
      options: value.options as Record<string, unknown> | undefined,
    };
  }
  throw new ConfigError("Each plugin must be a string or an object with an id field");
}

/**
 * Parse test configuration.
 */
function parseTestConfig(value: unknown): TestConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new ConfigError("test config must be an object");
  }
  return {
    command: toOptionalString(value.command),
    setup: Array.isArray(value.setup) ? value.setup.map(String) : undefined,
    timeout: typeof value.timeout === "number" ? value.timeout : undefined,
    env: toStringRecord(value.env, "test.env"),
  };
}

/**
 * Parse publish configuration.
 */
function parsePublishConfig(value: unknown): PublishConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new ConfigError("publish config must be an object");
  }
  const access = value.access;
  return {
    registry: toOptionalString(value.registry),
    provenance: typeof value.provenance === "boolean" ? value.provenance : undefined,
    access: access === "public" || access === "restricted" ? access : undefined,
    command: toOptionalString(value.command),
  };
}

// =============================================================================
// Config Validation
// =============================================================================

/**
 * Validate a distribution configuration.
 *
 * @param config Configuration to validate
 * @returns Validation result with errors and warnings
 */
export function validateConfig(config: DistConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate distDir
  if (!config.distDir || config.distDir.trim() === "") {
    errors.push("distDir cannot be empty");
  }
  if (config.distDir?.startsWith("/")) {
    errors.push("distDir must be a relative path");
  }
  if (config.distDir?.includes("..")) {
    warnings.push("distDir contains '..', which may cause unexpected behavior");
  }

  // Validate distributions
  const distNames = Object.keys(config.distributions);
  if (distNames.length === 0) {
    warnings.push("No distributions defined");
  }

  for (const [name, dist] of Object.entries(config.distributions)) {
    validateDistribution(name, dist, errors, warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a single distribution configuration.
 */
function validateDistribution(
  name: string,
  dist: DistributionConfig,
  errors: string[],
  warnings: string[],
): void {
  const prefix = `Distribution "${name}"`;

  // Validate name format (should be kebab-case)
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    warnings.push(`${prefix}: name should be kebab-case (e.g., "node", "node-18")`);
  }

  // Validate runtime
  if (!isValidRuntime(dist.runtime)) {
    errors.push(
      `${prefix}: invalid runtime "${dist.runtime}". ` +
        `Valid runtimes: ${VALID_RUNTIMES.join(", ")}`,
    );
  }

  // Validate versions
  if (dist.versions && dist.versions.length === 0) {
    warnings.push(`${prefix}: versions array is empty`);
  }

  // Validate plugins
  if (dist.plugins) {
    validatePluginConfig(dist, prefix, warnings);
  }

  // Validate custom script paths
  for (const field of ["preprocess", "transform", "postprocess"] as const) {
    const path = dist[field];
    if (path && !path.endsWith(".ts")) {
      warnings.push(`${prefix}: ${field} path "${path}" should be a .ts file`);
    }
  }

  // Validate templates
  if (dist.templates) {
    for (const [templateName, templatePath] of Object.entries(dist.templates)) {
      if (!templatePath) {
        errors.push(`${prefix}: template "${templateName}" has empty path`);
      }
    }
  }

  // Validate test config
  if (dist.test?.timeout !== undefined && dist.test.timeout < 0) {
    errors.push(`${prefix}: test timeout cannot be negative`);
  }

  // Validate publish config
  if (dist.publish?.access && !["public", "restricted"].includes(dist.publish.access)) {
    errors.push(`${prefix}: publish access must be "public" or "restricted"`);
  }
}

/**
 * Validate plugin configuration and @this usage.
 */
function validatePluginConfig(
  dist: DistributionConfig,
  prefix: string,
  warnings: string[],
): void {
  if (!dist.plugins) return;

  const hasThis = dist.plugins.some((p) =>
    (typeof p === "string" && p === "@this") ||
    (typeof p === "object" && p.id === "@this")
  );
  const hasCustomScript = dist.preprocess || dist.transform || dist.postprocess;

  if (hasThis && !hasCustomScript) {
    warnings.push(
      `${prefix}: @this in plugins but no custom preprocess/transform/postprocess defined`,
    );
  }
  if (hasCustomScript && !hasThis) {
    warnings.push(
      `${prefix}: custom scripts defined but @this not in plugins array - scripts won't run in order`,
    );
  }
}
