/**
 * @module plugins
 *
 * Plugin loading, resolution, and management for deno-dist.
 * Supports built-in plugins, external plugins, and custom scripts.
 */

import type {
  DistributionConfig,
  InlinePluginConfig,
  Plugin,
  PluginContext,
  PluginMetadata,
  PluginPhaseResult,
  PluginReference,
} from "../types.ts";
import { PluginError } from "../types.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Resolved plugin ready for execution.
 */
export interface ResolvedPlugin {
  /** Plugin instance */
  readonly plugin: Plugin;
  /** Plugin configuration */
  readonly config: InlinePluginConfig;
  /** Whether this is the @this placeholder for custom scripts */
  readonly isThis: boolean;
}

/**
 * Plugin registry for built-in and loaded plugins.
 */
export interface PluginRegistry {
  /** Registered plugins by ID */
  readonly plugins: Map<string, Plugin>;
}

// =============================================================================
// Plugin Registry
// =============================================================================

/** Global plugin registry */
const registry: PluginRegistry = {
  plugins: new Map(),
};

/** Memoized plugin load promises to avoid duplicate imports */
const loadPromises = new Map<string, Promise<Plugin>>();

/**
 * Register a plugin in the global registry.
 *
 * @param plugin Plugin to register
 */
export function registerPlugin(plugin: Plugin): void {
  registry.plugins.set(plugin.metadata.id, plugin);
}

/**
 * Get a plugin from the registry by ID.
 *
 * @param id Plugin ID
 * @returns Plugin or undefined
 */
export function getPlugin(id: string): Plugin | undefined {
  return registry.plugins.get(id);
}

/**
 * List all registered plugin IDs.
 *
 * @returns Array of plugin IDs
 */
export function listPlugins(): readonly string[] {
  return [...registry.plugins.keys()];
}

/**
 * Clear the plugin registry and load cache.
 * Useful for testing.
 */
export function clearPluginCache(): void {
  registry.plugins.clear();
  loadPromises.clear();
}

// =============================================================================
// Plugin Validation
// =============================================================================

/**
 * Validate that a plugin has the required structure.
 */
function validatePluginMetadata(metadata: unknown): metadata is PluginMetadata {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const m = metadata as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    m.id.length > 0 &&
    typeof m.name === "string" &&
    typeof m.version === "string"
  );
}

/**
 * Check if an object is a valid plugin.
 */
function isValidPlugin(obj: unknown): obj is Plugin {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  const plugin = obj as Record<string, unknown>;

  // Must have valid metadata
  if (!validatePluginMetadata(plugin.metadata)) {
    return false;
  }

  // If phase methods exist, they must be functions
  for (const phase of ["preprocess", "transform", "postprocess"]) {
    if (phase in plugin && typeof plugin[phase] !== "function") {
      return false;
    }
  }

  return true;
}

// =============================================================================
// Built-in Plugin Loading
// =============================================================================

/** Built-in plugin IDs */
const BUILTIN_PLUGINS = new Set(["deno-to-node", "deno-to-bun", "deno-passthrough"]);

/**
 * Check if a plugin ID is a built-in plugin.
 */
function isBuiltinPlugin(id: string): boolean {
  return BUILTIN_PLUGINS.has(id);
}

/**
 * Load a built-in plugin by ID.
 */
async function loadBuiltinPlugin(id: string): Promise<Plugin | undefined> {
  switch (id) {
    case "deno-to-node":
      return (await import("./deno_to_node.ts")).default;
    case "deno-to-bun":
      return (await import("./deno_to_bun.ts")).default;
    case "deno-passthrough":
      return (await import("./deno_passthrough.ts")).default;
    default:
      return undefined;
  }
}

// =============================================================================
// Plugin Loading
// =============================================================================

/**
 * Load a plugin by ID or path.
 * Results are memoized to avoid duplicate imports.
 *
 * @param id Plugin ID or file path
 * @returns Loaded plugin
 * @throws PluginError if plugin cannot be loaded
 */
export async function loadPlugin(id: string): Promise<Plugin> {
  // Check registry first (already loaded)
  const registered = registry.plugins.get(id);
  if (registered) {
    return registered;
  }

  // Check for in-flight load promise (deduplication)
  const existingPromise = loadPromises.get(id);
  if (existingPromise) {
    return existingPromise;
  }

  // Create and cache the load promise
  const loadPromise = doLoadPlugin(id);
  loadPromises.set(id, loadPromise);

  try {
    const plugin = await loadPromise;
    registerPlugin(plugin);
    return plugin;
  } catch (error) {
    // Remove failed promise from cache
    loadPromises.delete(id);
    throw error;
  }
}

/**
 * Internal plugin loading implementation.
 */
async function doLoadPlugin(id: string): Promise<Plugin> {
  // Check for built-in plugins
  if (isBuiltinPlugin(id)) {
    const builtin = await loadBuiltinPlugin(id);
    if (builtin) {
      return builtin;
    }
  }

  // Try to load as external module
  try {
    const module = await import(id);
    const plugin = module.default ?? module;

    if (!isValidPlugin(plugin)) {
      throw new PluginError(
        `Module "${id}" does not export a valid plugin. ` +
          "Plugins must have a metadata object with id, name, and version fields.",
        id,
      );
    }

    return plugin;
  } catch (error) {
    if (error instanceof PluginError) {
      throw error;
    }
    throw new PluginError(
      `Failed to load plugin "${id}": ${String(error)}`,
      id,
    );
  }
}

// =============================================================================
// Plugin Resolution
// =============================================================================

/**
 * Resolve plugin references to loaded plugins with proper ordering.
 *
 * The @this keyword is used to indicate where custom scripts should run
 * in the plugin execution order.
 *
 * @param references Plugin references from configuration
 * @param distConfig Distribution configuration (for custom script paths)
 * @returns Resolved plugins in execution order
 */
export async function resolvePlugins(
  references: readonly PluginReference[] | undefined,
  distConfig: DistributionConfig,
): Promise<readonly ResolvedPlugin[]> {
  const hasCustomScripts = distConfig.preprocess || distConfig.transform || distConfig.postprocess;

  if (!references || references.length === 0) {
    // If no plugins specified but custom scripts exist, run them
    if (hasCustomScripts) {
      return [createThisPlugin(distConfig)];
    }
    return [];
  }

  // Normalize all references first
  const normalized = references.map(normalizeReference);

  // Identify plugins that need loading (not @this)
  const pluginsToLoad = normalized
    .filter((c) => c.id !== "@this")
    .map((c) => c.id);

  // Deduplicate plugin IDs
  const uniquePluginIds = [...new Set(pluginsToLoad)];

  // Load all unique plugins in parallel
  const loadedPlugins = await Promise.all(
    uniquePluginIds.map((id) => loadPlugin(id)),
  );

  // Create a map for quick lookup
  const pluginMap = new Map<string, Plugin>();
  uniquePluginIds.forEach((id, i) => {
    pluginMap.set(id, loadedPlugins[i]);
  });

  // Build resolved array maintaining order
  return normalized.map((config) => {
    if (config.id === "@this") {
      return createThisPlugin(distConfig);
    }
    return {
      plugin: pluginMap.get(config.id)!,
      config,
      isThis: false,
    };
  });
}

/**
 * Normalize a plugin reference to an InlinePluginConfig.
 */
function normalizeReference(ref: PluginReference): InlinePluginConfig {
  return typeof ref === "string" ? { id: ref } : ref;
}

/**
 * Create a resolved plugin for @this (custom scripts).
 */
function createThisPlugin(distConfig: DistributionConfig): ResolvedPlugin {
  return {
    plugin: createCustomScriptPlugin(distConfig),
    config: { id: "@this" },
    isThis: true,
  };
}

/**
 * Create a plugin wrapper for custom scripts.
 */
function createCustomScriptPlugin(distConfig: DistributionConfig): Plugin {
  const metadata: PluginMetadata = {
    id: "@this",
    name: "Custom Scripts",
    version: "0.0.0",
    description: "User-defined preprocess/transform/postprocess scripts",
    targetRuntime: distConfig.runtime,
  };

  return {
    metadata,
    preprocess(context: PluginContext): Promise<PluginPhaseResult> {
      if (!distConfig.preprocess) {
        return Promise.resolve({ success: true });
      }
      return runCustomScript(distConfig.preprocess, "preprocess", context);
    },
    transform(context: PluginContext): Promise<PluginPhaseResult> {
      if (!distConfig.transform) {
        return Promise.resolve({ success: true });
      }
      return runCustomScript(distConfig.transform, "transform", context);
    },
    postprocess(context: PluginContext): Promise<PluginPhaseResult> {
      if (!distConfig.postprocess) {
        return Promise.resolve({ success: true });
      }
      return runCustomScript(distConfig.postprocess, "postprocess", context);
    },
  };
}

/**
 * Run a custom script for a specific phase.
 */
async function runCustomScript(
  scriptPath: string,
  phase: "preprocess" | "transform" | "postprocess",
  context: PluginContext,
): Promise<PluginPhaseResult> {
  const startTime = Date.now();

  try {
    const module = await import(scriptPath);
    const handler = module[phase] ?? module.default?.[phase];

    if (typeof handler !== "function") {
      return {
        success: false,
        error: `Script "${scriptPath}" does not export a "${phase}" function`,
        durationMs: Date.now() - startTime,
      };
    }

    const result = await handler(context);
    const durationMs = Date.now() - startTime;

    // Normalize result
    if (typeof result === "object" && result !== null) {
      return { ...result, durationMs };
    }

    return { success: true, durationMs };
  } catch (error) {
    return {
      success: false,
      error: `Failed to run custom script "${scriptPath}": ${String(error)}`,
      durationMs: Date.now() - startTime,
    };
  }
}

// =============================================================================
// Exports
// =============================================================================

export type { Plugin, PluginContext, PluginMetadata, PluginPhaseResult };
