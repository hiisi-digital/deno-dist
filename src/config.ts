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

  if (!raw || typeof raw !== "object") {
    throw new ConfigError("Configuration must be an object");
  }

  const distDir = typeof raw.distDir === "string" ? raw.distDir : DEFAULT_DIST_DIR;
  const distributions = parseDistributions(raw.dist);

  return {
    distDir,
    distributions,
  };
}

/**
 * Parse distribution configurations from raw dist object.
 */
function parseDistributions(
  raw: RawDistConfig | undefined,
): Record<string, DistributionConfig> {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const distributions: Record<string, DistributionConfig> = {};

  for (const [name, value] of Object.entries(raw)) {
    if (value && typeof value === "object") {
      distributions[name] = parseDistributionConfig(name, value as Record<string, unknown>);
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
  const runtime = parseRuntime(raw.runtime, name);
  const versions = parseVersions(raw.versions);
  const plugins = parsePlugins(raw.plugins);
  const preprocess = parseOptionalString(raw.preprocess);
  const transform = parseOptionalString(raw.transform);
  const postprocess = parseOptionalString(raw.postprocess);
  const templates = parseStringRecord(raw.templates);
  const replacements = parseStringRecord(raw.replacements);
  const test = parseTestConfig(raw.test);
  const publish = parsePublishConfig(raw.publish);

  return {
    runtime,
    versions,
    plugins,
    preprocess,
    transform,
    postprocess,
    templates,
    replacements,
    test,
    publish,
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
  if (!VALID_RUNTIMES.includes(value as RuntimeId)) {
    throw new ConfigError(
      `Distribution "${distName}" has invalid runtime "${value}". ` +
        `Valid runtimes: ${VALID_RUNTIMES.join(", ")}`,
    );
  }
  return value as RuntimeId;
}

/**
 * Parse versions array.
 */
function parseVersions(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ConfigError("versions must be an array");
  }
  return value.map((v) => String(v));
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
  return value.map((v) => {
    if (typeof v === "string") {
      return v;
    }
    if (v && typeof v === "object" && "id" in v) {
      return {
        id: String((v as Record<string, unknown>).id),
        options: (v as Record<string, unknown>).options as Record<string, unknown> | undefined,
      };
    }
    throw new ConfigError("Each plugin must be a string or an object with an id field");
  });
}

/**
 * Parse optional string field.
 */
function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

/**
 * Parse string record (templates, replacements).
 */
function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new ConfigError("Expected an object for templates/replacements");
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = String(v);
  }
  return result;
}

/**
 * Parse test configuration.
 */
function parseTestConfig(value: unknown): TestConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new ConfigError("test config must be an object");
  }
  const raw = value as Record<string, unknown>;
  return {
    command: parseOptionalString(raw.command),
    setup: raw.setup && Array.isArray(raw.setup) ? raw.setup.map((s) => String(s)) : undefined,
    timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    env: parseStringRecord(raw.env),
  };
}

/**
 * Parse publish configuration.
 */
function parsePublishConfig(value: unknown): PublishConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new ConfigError("publish config must be an object");
  }
  const raw = value as Record<string, unknown>;
  return {
    registry: parseOptionalString(raw.registry),
    provenance: typeof raw.provenance === "boolean" ? raw.provenance : undefined,
    access: raw.access === "public" || raw.access === "restricted" ? raw.access : undefined,
    command: parseOptionalString(raw.command),
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

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
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
  if (!VALID_RUNTIMES.includes(dist.runtime)) {
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
  if (dist.test) {
    if (dist.test.timeout !== undefined && dist.test.timeout < 0) {
      errors.push(`${prefix}: test timeout cannot be negative`);
    }
  }

  // Validate publish config
  if (dist.publish) {
    if (dist.publish.access && !["public", "restricted"].includes(dist.publish.access)) {
      errors.push(`${prefix}: publish access must be "public" or "restricted"`);
    }
  }
}
