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

/**
 * Custom script implementation for preprocess/transform/postprocess.
 */
export interface CustomScript {
  /** Script file path */
  readonly path: string;
  /** The loaded module */
  readonly module: {
    preprocess?(context: PluginContext): Promise<PluginPhaseResult>;
    transform?(context: PluginContext): Promise<PluginPhaseResult>;
    postprocess?(context: PluginContext): Promise<PluginPhaseResult>;
  };
}

// =============================================================================
// Plugin Registry
// =============================================================================

/** Global plugin registry */
const registry: PluginRegistry = {
  plugins: new Map(),
};

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

// =============================================================================
// Plugin Loading
// =============================================================================

/**
 * Load a plugin by ID or path.
 *
 * @param id Plugin ID or file path
 * @returns Loaded plugin
 * @throws PluginError if plugin cannot be loaded
 */
export async function loadPlugin(id: string): Promise<Plugin> {
  // Check registry first
  const registered = registry.plugins.get(id);
  if (registered) {
    return registered;
  }

  // Check for built-in plugins
  const builtin = await loadBuiltinPlugin(id);
  if (builtin) {
    registerPlugin(builtin);
    return builtin;
  }

  // Try to load as external module
  try {
    const module = await import(id);
    if (!isValidPlugin(module.default)) {
      throw new PluginError(
        `Module "${id}" does not export a valid plugin`,
        id,
      );
    }
    const plugin = module.default as Plugin;
    registerPlugin(plugin);
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

/**
 * Check if an object is a valid plugin.
 */
function isValidPlugin(obj: unknown): obj is Plugin {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  const plugin = obj as Record<string, unknown>;
  if (!plugin.metadata || typeof plugin.metadata !== "object") {
    return false;
  }
  const metadata = plugin.metadata as Record<string, unknown>;
  return (
    typeof metadata.id === "string" &&
    typeof metadata.name === "string" &&
    typeof metadata.version === "string"
  );
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
  if (!references || references.length === 0) {
    // If no plugins specified but custom scripts exist, run them
    const hasCustomScripts =
      distConfig.preprocess || distConfig.transform || distConfig.postprocess;
    if (hasCustomScripts) {
      return [
        {
          plugin: createCustomScriptPlugin(distConfig),
          config: { id: "@this" },
          isThis: true,
        },
      ];
    }
    return [];
  }

  const resolved: ResolvedPlugin[] = [];

  for (const ref of references) {
    const config = normalizeReference(ref);

    if (config.id === "@this") {
      // Insert custom script placeholder
      resolved.push({
        plugin: createCustomScriptPlugin(distConfig),
        config,
        isThis: true,
      });
    } else {
      // Load the plugin
      const plugin = await loadPlugin(config.id);
      resolved.push({
        plugin,
        config,
        isThis: false,
      });
    }
  }

  return resolved;
}

/**
 * Normalize a plugin reference to an InlinePluginConfig.
 */
function normalizeReference(ref: PluginReference): InlinePluginConfig {
  if (typeof ref === "string") {
    return { id: ref };
  }
  return ref;
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
    async preprocess(context: PluginContext): Promise<PluginPhaseResult> {
      if (!distConfig.preprocess) {
        return { success: true };
      }
      return runCustomScript(distConfig.preprocess, "preprocess", context);
    },
    async transform(context: PluginContext): Promise<PluginPhaseResult> {
      if (!distConfig.transform) {
        return { success: true };
      }
      return runCustomScript(distConfig.transform, "transform", context);
    },
    async postprocess(context: PluginContext): Promise<PluginPhaseResult> {
      if (!distConfig.postprocess) {
        return { success: true };
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
    const handler = module[phase] || module.default?.[phase];

    if (typeof handler !== "function") {
      return {
        success: false,
        error: `Script "${scriptPath}" does not export a "${phase}" function`,
      };
    }

    const result = await handler(context);

    // Normalize result
    if (typeof result === "object" && result !== null) {
      return {
        ...result,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      success: true,
      durationMs: Date.now() - startTime,
    };
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

