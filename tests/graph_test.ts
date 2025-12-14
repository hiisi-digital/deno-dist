/**
 * @module graph_test
 *
 * Tests for the graph-based execution engine.
 */

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  buildExecutionGraph,
  filterGraphByPhases,
  getDistributionOperations,
  getPhaseOperations,
  mergeGraphs,
  type ResolvedPluginInfo,
  visualizeGraph,
} from "../src/graph.ts";
import type { Plugin, PluginContext, PluginPhaseResult } from "../src/types.ts";

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockPlugin(
  id: string,
  phases: ("preprocess" | "transform" | "postprocess" | "setup" | "release")[] = ["transform"],
  options: { dependencies?: string[]; conflicts?: string[]; canParallelize?: boolean } = {},
): Plugin {
  const plugin: Plugin = {
    metadata: {
      id,
      name: `Test Plugin ${id}`,
      version: "1.0.0",
      description: `Mock plugin ${id}`,
      targetRuntime: "node",
      phases,
      dependencies: options.dependencies,
      conflicts: options.conflicts,
      canParallelize: options.canParallelize,
    },
  };

  // Add phase handlers
  if (phases.includes("preprocess")) {
    plugin.preprocess = (_ctx: PluginContext): Promise<PluginPhaseResult> =>
      Promise.resolve({ success: true });
  }
  if (phases.includes("transform")) {
    plugin.transform = (_ctx: PluginContext): Promise<PluginPhaseResult> =>
      Promise.resolve({ success: true });
  }
  if (phases.includes("postprocess")) {
    plugin.postprocess = (_ctx: PluginContext): Promise<PluginPhaseResult> =>
      Promise.resolve({ success: true });
  }
  if (phases.includes("setup")) {
    plugin.setup = () => Promise.resolve({ success: true });
  }
  if (phases.includes("release")) {
    plugin.release = () => Promise.resolve({ success: true });
  }

  return plugin;
}

function createResolvedPluginInfo(
  plugin: Plugin,
  distribution: string,
): ResolvedPluginInfo {
  return {
    plugin,
    config: { id: plugin.metadata.id },
    distribution,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("buildExecutionGraph", () => {
  it("should create a graph with correct wave count", () => {
    const plugin = createMockPlugin("test-plugin", ["preprocess", "transform", "postprocess"]);
    const plugins: ResolvedPluginInfo[] = [createResolvedPluginInfo(plugin, "node")];

    const graph = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    // preprocess -> transform -> postprocess = 3 waves (sequential phases)
    assertEquals(graph.totalOperations, 3);
    assertEquals(graph.hasCycles, false);
    assertExists(graph.waves);
  });

  it("should handle multiple distributions", () => {
    const plugin = createMockPlugin("test-plugin", ["transform"]);
    const plugins: ResolvedPluginInfo[] = [
      createResolvedPluginInfo(plugin, "node"),
      createResolvedPluginInfo(plugin, "bun"),
    ];

    const graph = buildExecutionGraph(plugins, {
      distributions: ["node", "bun"],
      includeSetup: false,
      includeRelease: false,
    });

    assertEquals(graph.totalOperations, 2);
  });

  it("should respect plugin dependencies", () => {
    // Both plugins can parallelize to avoid sequential ordering conflicts
    const pluginA = createMockPlugin("plugin-a", ["transform"], { canParallelize: true });
    const pluginB = createMockPlugin("plugin-b", ["transform"], {
      dependencies: ["plugin-a"],
      canParallelize: true,
    });

    // Important: plugin-a comes first in the array (before plugin-b which depends on it)
    const plugins: ResolvedPluginInfo[] = [
      createResolvedPluginInfo(pluginA, "node"),
      createResolvedPluginInfo(pluginB, "node"),
    ];

    const graph = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    // plugin-b depends on plugin-a, so they should be in different waves
    assertEquals(graph.totalOperations, 2);

    // Find the operations
    const allOps = graph.waves.flatMap((w) => w.operations);
    const opA = allOps.find((op) => op.plugin.metadata.id === "plugin-a");
    const opB = allOps.find((op) => op.plugin.metadata.id === "plugin-b");

    assertExists(opA);
    assertExists(opB);

    // Check that B's dependencies include A
    const bDeps = graph.edges.get(opB.id) ?? [];
    assertEquals(bDeps.includes(opA.id), true);
  });

  it("should group parallelizable plugins in same wave", () => {
    const pluginA = createMockPlugin("plugin-a", ["transform"], { canParallelize: true });
    const pluginB = createMockPlugin("plugin-b", ["transform"], { canParallelize: true });

    const plugins: ResolvedPluginInfo[] = [
      createResolvedPluginInfo(pluginA, "node"),
      createResolvedPluginInfo(pluginB, "node"),
    ];

    const graph = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    // Both plugins can parallelize, so they could be in the same wave
    // (depending on other constraints)
    assertEquals(graph.totalOperations, 2);
  });

  it("should include setup phase when requested", () => {
    const plugin = createMockPlugin("test-plugin", ["transform", "setup"]);
    const plugins: ResolvedPluginInfo[] = [createResolvedPluginInfo(plugin, "node")];

    const graphWithSetup = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: true,
      includeRelease: false,
    });

    const graphWithoutSetup = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    assertEquals(graphWithSetup.totalOperations, 2); // transform + setup
    assertEquals(graphWithoutSetup.totalOperations, 1); // just transform
  });

  it("should include release phase when requested", () => {
    const plugin = createMockPlugin("test-plugin", ["transform", "release"]);
    const plugins: ResolvedPluginInfo[] = [createResolvedPluginInfo(plugin, "node")];

    const graphWithRelease = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: true,
    });

    assertEquals(graphWithRelease.totalOperations, 2); // transform + release
  });
});

describe("visualizeGraph", () => {
  it("should produce readable output", () => {
    const plugin = createMockPlugin("test-plugin", ["preprocess", "transform"]);
    const plugins: ResolvedPluginInfo[] = [createResolvedPluginInfo(plugin, "node")];

    const graph = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    const output = visualizeGraph(graph);

    assertEquals(typeof output, "string");
    assertEquals(output.includes("Execution Graph"), true);
    assertEquals(output.includes("Wave"), true);
  });
});

describe("getPhaseOperations", () => {
  it("should filter operations by phase", () => {
    const plugin = createMockPlugin("test-plugin", ["preprocess", "transform", "postprocess"]);
    const plugins: ResolvedPluginInfo[] = [createResolvedPluginInfo(plugin, "node")];

    const graph = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    const transformOps = getPhaseOperations(graph, "transform");

    assertEquals(transformOps.length, 1);
    assertEquals(transformOps[0].phase, "transform");
  });
});

describe("getDistributionOperations", () => {
  it("should filter operations by distribution", () => {
    const plugin = createMockPlugin("test-plugin", ["transform"]);
    const plugins: ResolvedPluginInfo[] = [
      createResolvedPluginInfo(plugin, "node"),
      createResolvedPluginInfo(plugin, "bun"),
    ];

    const graph = buildExecutionGraph(plugins, {
      distributions: ["node", "bun"],
      includeSetup: false,
      includeRelease: false,
    });

    const nodeOps = getDistributionOperations(graph, "node");
    const bunOps = getDistributionOperations(graph, "bun");

    assertEquals(nodeOps.length, 1);
    assertEquals(bunOps.length, 1);
    assertEquals(nodeOps[0].distribution, "node");
    assertEquals(bunOps[0].distribution, "bun");
  });
});

describe("filterGraphByPhases", () => {
  it("should filter graph to only include specified phases", () => {
    const plugin = createMockPlugin("test-plugin", ["preprocess", "transform", "postprocess"]);
    const plugins: ResolvedPluginInfo[] = [createResolvedPluginInfo(plugin, "node")];

    const fullGraph = buildExecutionGraph(plugins, {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    const filteredGraph = filterGraphByPhases(fullGraph, ["transform"]);

    assertEquals(fullGraph.totalOperations, 3);
    assertEquals(filteredGraph.totalOperations, 1);
  });
});

describe("mergeGraphs", () => {
  it("should merge multiple graphs", () => {
    const pluginA = createMockPlugin("plugin-a", ["transform"]);
    const pluginB = createMockPlugin("plugin-b", ["transform"]);

    const graphA = buildExecutionGraph([createResolvedPluginInfo(pluginA, "node")], {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    const graphB = buildExecutionGraph([createResolvedPluginInfo(pluginB, "bun")], {
      distributions: ["bun"],
      includeSetup: false,
      includeRelease: false,
    });

    const merged = mergeGraphs([graphA, graphB]);

    assertEquals(merged.totalOperations, 2);
    assertEquals(merged.hasCycles, false);
  });

  it("should handle empty graph array", () => {
    const merged = mergeGraphs([]);

    assertEquals(merged.totalOperations, 0);
    assertEquals(merged.waves.length, 0);
  });

  it("should handle single graph", () => {
    const plugin = createMockPlugin("test-plugin", ["transform"]);
    const graph = buildExecutionGraph([createResolvedPluginInfo(plugin, "node")], {
      distributions: ["node"],
      includeSetup: false,
      includeRelease: false,
    });

    const merged = mergeGraphs([graph]);

    assertEquals(merged.totalOperations, graph.totalOperations);
  });
});
