/**
 * @module plugin_test
 *
 * Tests for plugin validation and conflict detection.
 */

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { checkPluginConflicts, isBuiltinPlugin, validatePlugin } from "../src/plugins/mod.ts";
import type { Plugin, PluginContext, PluginPhaseResult } from "../src/types.ts";

// =============================================================================
// Test Fixtures
// =============================================================================

function createValidPlugin(overrides: Partial<Plugin["metadata"]> = {}): Plugin {
  return {
    metadata: {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      targetRuntime: "node",
      ...overrides,
    },
    transform: (_ctx: PluginContext): Promise<PluginPhaseResult> =>
      Promise.resolve({ success: true }),
  };
}

// =============================================================================
// validatePlugin Tests
// =============================================================================

describe("validatePlugin", () => {
  it("should validate a valid plugin", () => {
    const plugin = createValidPlugin();
    const result = validatePlugin(plugin);

    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
  });

  it("should error on missing id", () => {
    const plugin = createValidPlugin({ id: "" });
    const result = validatePlugin(plugin);

    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e) => e.includes("id")), true);
  });

  it("should error on missing name", () => {
    const plugin = createValidPlugin({ name: "" });
    const result = validatePlugin(plugin);

    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e) => e.includes("name")), true);
  });

  it("should error on missing version", () => {
    const plugin = createValidPlugin({ version: "" });
    const result = validatePlugin(plugin);

    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e) => e.includes("version")), true);
  });

  it("should warn on non-kebab-case id", () => {
    const plugin = createValidPlugin({ id: "TestPlugin" });
    const result = validatePlugin(plugin);

    assertEquals(result.warnings.some((w) => w.includes("kebab-case")), true);
  });

  it("should warn on missing description", () => {
    const plugin = createValidPlugin({ description: "" });
    const result = validatePlugin(plugin);

    assertEquals(result.warnings.some((w) => w.includes("description")), true);
  });

  it("should warn on missing targetRuntime", () => {
    const plugin = createValidPlugin({ targetRuntime: undefined as unknown as "node" });
    const result = validatePlugin(plugin);

    assertEquals(result.warnings.some((w) => w.includes("targetRuntime")), true);
  });

  it("should warn if plugin declares phase but doesn't implement it", () => {
    const plugin: Plugin = {
      metadata: {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        description: "A test plugin",
        targetRuntime: "node",
        phases: ["transform", "postprocess"], // declares postprocess
      },
      // Only implements transform, not postprocess
      transform: (_ctx: PluginContext): Promise<PluginPhaseResult> =>
        Promise.resolve({ success: true }),
    };

    const result = validatePlugin(plugin);

    assertEquals(
      result.warnings.some((w) => w.includes("postprocess") && w.includes("does not implement")),
      true,
    );
  });

  it("should warn if plugin implements no phases", () => {
    const plugin: Plugin = {
      metadata: {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        description: "A test plugin",
        targetRuntime: "node",
      },
      // No phase handlers
    };

    const result = validatePlugin(plugin);

    assertEquals(result.warnings.some((w) => w.includes("does not implement any phases")), true);
  });

  it("should error on invalid phase in phases array", () => {
    const plugin: Plugin = {
      metadata: {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        description: "A test plugin",
        targetRuntime: "node",
        phases: ["transform", "invalid-phase" as "transform"],
      },
      transform: (_ctx: PluginContext): Promise<PluginPhaseResult> =>
        Promise.resolve({ success: true }),
    };

    const result = validatePlugin(plugin);

    assertEquals(result.errors.some((e) => e.includes("Invalid phase")), true);
  });

  it("should error if dependencies is not an array", () => {
    const plugin = createValidPlugin({
      dependencies: "not-an-array" as unknown as string[],
    });
    const result = validatePlugin(plugin);

    assertEquals(result.errors.some((e) => e.includes("dependencies")), true);
  });

  it("should error if conflicts is not an array", () => {
    const plugin = createValidPlugin({
      conflicts: "not-an-array" as unknown as string[],
    });
    const result = validatePlugin(plugin);

    assertEquals(result.errors.some((e) => e.includes("conflicts")), true);
  });

  it("should accept @this as valid id", () => {
    const plugin = createValidPlugin({ id: "@this" });
    const result = validatePlugin(plugin);

    assertEquals(result.valid, true);
    assertEquals(result.warnings.some((w) => w.includes("kebab-case")), false);
  });
});

// =============================================================================
// checkPluginConflicts Tests
// =============================================================================

describe("checkPluginConflicts", () => {
  it("should detect conflicts between plugins", () => {
    const pluginA: Plugin = {
      metadata: {
        id: "plugin-a",
        name: "Plugin A",
        version: "1.0.0",
        description: "Plugin A",
        targetRuntime: "node",
        conflicts: ["plugin-b"],
      },
    };

    const pluginB: Plugin = {
      metadata: {
        id: "plugin-b",
        name: "Plugin B",
        version: "1.0.0",
        description: "Plugin B",
        targetRuntime: "node",
      },
    };

    const conflicts = checkPluginConflicts([pluginA, pluginB]);

    assertEquals(conflicts.length, 1);
    assertEquals(conflicts[0].includes("plugin-a"), true);
    assertEquals(conflicts[0].includes("plugin-b"), true);
  });

  it("should return empty array when no conflicts", () => {
    const pluginA: Plugin = {
      metadata: {
        id: "plugin-a",
        name: "Plugin A",
        version: "1.0.0",
        description: "Plugin A",
        targetRuntime: "node",
      },
    };

    const pluginB: Plugin = {
      metadata: {
        id: "plugin-b",
        name: "Plugin B",
        version: "1.0.0",
        description: "Plugin B",
        targetRuntime: "node",
      },
    };

    const conflicts = checkPluginConflicts([pluginA, pluginB]);

    assertEquals(conflicts.length, 0);
  });

  it("should detect bidirectional conflicts", () => {
    const pluginA: Plugin = {
      metadata: {
        id: "plugin-a",
        name: "Plugin A",
        version: "1.0.0",
        description: "Plugin A",
        targetRuntime: "node",
        conflicts: ["plugin-b"],
      },
    };

    const pluginB: Plugin = {
      metadata: {
        id: "plugin-b",
        name: "Plugin B",
        version: "1.0.0",
        description: "Plugin B",
        targetRuntime: "node",
        conflicts: ["plugin-a"],
      },
    };

    const conflicts = checkPluginConflicts([pluginA, pluginB]);

    // Both plugins declare conflict, so we should have 2 conflict messages
    assertEquals(conflicts.length, 2);
  });

  it("should handle empty plugin array", () => {
    const conflicts = checkPluginConflicts([]);

    assertEquals(conflicts.length, 0);
  });

  it("should handle single plugin", () => {
    const plugin: Plugin = {
      metadata: {
        id: "plugin-a",
        name: "Plugin A",
        version: "1.0.0",
        description: "Plugin A",
        targetRuntime: "node",
        conflicts: ["plugin-b"], // Conflicts with non-existent plugin
      },
    };

    const conflicts = checkPluginConflicts([plugin]);

    // No conflict because plugin-b is not in the array
    assertEquals(conflicts.length, 0);
  });
});

// =============================================================================
// isBuiltinPlugin Tests
// =============================================================================

describe("isBuiltinPlugin", () => {
  it("should recognize deno-to-node as builtin", () => {
    assertEquals(isBuiltinPlugin("deno-to-node"), true);
  });

  it("should recognize deno-to-bun as builtin", () => {
    assertEquals(isBuiltinPlugin("deno-to-bun"), true);
  });

  it("should recognize deno-passthrough as builtin", () => {
    assertEquals(isBuiltinPlugin("deno-passthrough"), true);
  });

  it("should recognize github-actions as builtin", () => {
    assertEquals(isBuiltinPlugin("github-actions"), true);
  });

  it("should not recognize random plugin as builtin", () => {
    assertEquals(isBuiltinPlugin("my-custom-plugin"), false);
  });

  it("should not recognize empty string as builtin", () => {
    assertEquals(isBuiltinPlugin(""), false);
  });

  it("should not recognize jsr specifier as builtin", () => {
    assertEquals(isBuiltinPlugin("jsr:@someone/plugin"), false);
  });
});
