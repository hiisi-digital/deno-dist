/**
 * @module graph
 *
 * Graph-based pipeline execution engine for deno-dist.
 * Builds a dependency graph of plugin operations and executes them
 * in parallel waves where possible.
 */

import { BUILD_PHASE_IDS, isBuildPhase } from "./generated_types.ts";
import type {
  DistConfig,
  ExecutionGraph,
  ExecutionOperation,
  ExecutionWave,
  GraphExecutionResult,
  InlinePluginConfig,
  PhaseId,
  Plugin,
  PluginContext,
  PluginPhaseResult,
  ReleaseContext,
  SetupContext,
} from "./types.ts";
import { getPluginPhases, GraphError } from "./types.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for building an execution graph.
 */
export interface GraphBuildOptions {
  /** Distributions to include */
  readonly distributions: readonly string[];
  /** Phases to include (defaults to all) */
  readonly phases?: readonly PhaseId[];
  /** Whether to include setup phases */
  readonly includeSetup?: boolean;
  /** Whether to include release phases */
  readonly includeRelease?: boolean;
}

/**
 * Resolved plugin with its configuration.
 */
export interface ResolvedPluginInfo {
  /** Plugin instance */
  readonly plugin: Plugin;
  /** Plugin configuration */
  readonly config: InlinePluginConfig;
  /** Distribution this plugin is for */
  readonly distribution: string;
}

/**
 * Internal node in the dependency graph.
 */
interface GraphNode {
  /** Operation for this node */
  readonly operation: ExecutionOperation;
  /** IDs of operations this depends on */
  readonly dependencies: Set<string>;
  /** IDs of operations that depend on this */
  readonly dependents: Set<string>;
  /** Whether this node has been processed */
  processed: boolean;
}

// =============================================================================
// Operation ID Generation
// =============================================================================

/**
 * Generate a unique operation ID.
 */
function operationId(distribution: string, pluginId: string, phase: PhaseId): string {
  return `${distribution}:${pluginId}:${phase}`;
}

/**
 * Parse an operation ID into its components.
 */
function parseOperationId(id: string): { distribution: string; pluginId: string; phase: PhaseId } {
  const [distribution, pluginId, phase] = id.split(":");
  return { distribution, pluginId, phase: phase as PhaseId };
}

// =============================================================================
// Graph Building
// =============================================================================

/**
 * Build an execution graph from resolved plugins.
 */
export function buildExecutionGraph(
  plugins: readonly ResolvedPluginInfo[],
  options: GraphBuildOptions,
): ExecutionGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, string[]>();

  // Determine which phases to include
  const phasesToInclude = new Set<PhaseId>(
    options.phases ?? [
      ...(options.includeSetup !== false ? ["setup" as PhaseId] : []),
      ...BUILD_PHASE_IDS,
      ...(options.includeRelease !== false ? ["release" as PhaseId] : []),
    ],
  );

  // First pass: Create all nodes
  for (const { plugin, config, distribution } of plugins) {
    const implementedPhases = getPluginPhases(plugin);

    for (const phase of implementedPhases) {
      if (!phasesToInclude.has(phase)) continue;

      const id = operationId(distribution, plugin.metadata.id, phase);
      const operation: ExecutionOperation = {
        id,
        plugin,
        phase,
        distribution,
        config,
      };

      nodes.set(id, {
        operation,
        dependencies: new Set(),
        dependents: new Set(),
        processed: false,
      });
    }
  }

  // Second pass: Add dependency edges
  for (const [id, node] of nodes) {
    const { distribution, pluginId, phase } = parseOperationId(id);

    // 1. Phase ordering within the same distribution
    // preprocess -> transform -> postprocess (sequential)
    // setup and release are independent of build phases
    if (isBuildPhase(phase)) {
      const phaseOrder: PhaseId[] = ["preprocess", "transform", "postprocess"];
      const phaseIndex = phaseOrder.indexOf(phase);

      if (phaseIndex > 0) {
        // Find all operations in the previous phase for this distribution
        for (const [otherId, otherNode] of nodes) {
          const other = parseOperationId(otherId);
          if (
            other.distribution === distribution &&
            other.phase === phaseOrder[phaseIndex - 1]
          ) {
            node.dependencies.add(otherId);
            otherNode.dependents.add(id);
          }
        }
      }
    }

    // 2. Release phases depend on all build phases completing
    if (phase === "release") {
      for (const [otherId, otherNode] of nodes) {
        const other = parseOperationId(otherId);
        if (other.distribution === distribution && isBuildPhase(other.phase)) {
          node.dependencies.add(otherId);
          otherNode.dependents.add(id);
        }
      }
    }

    // 3. Plugin-declared dependencies
    const metadata = node.operation.plugin.metadata;
    if (metadata.dependencies) {
      for (const depPluginId of metadata.dependencies) {
        // Find operations for this dependency in the same distribution and phase
        const depId = operationId(distribution, depPluginId, phase);
        if (nodes.has(depId)) {
          node.dependencies.add(depId);
          const depNode = nodes.get(depId)!;
          depNode.dependents.add(id);
        }
      }
    }

    // 4. Plugin ordering within the same phase (based on config order)
    // Plugins that appear later in the config depend on earlier plugins
    // unless they can parallelize
    if (!metadata.canParallelize) {
      const samePhasePlugins = plugins
        .filter((p) => p.distribution === distribution)
        .filter((p) => getPluginPhases(p.plugin).includes(phase));

      const myIndex = samePhasePlugins.findIndex(
        (p) => p.plugin.metadata.id === pluginId,
      );

      if (myIndex > 0) {
        const prevPlugin = samePhasePlugins[myIndex - 1];
        // Only add dependency if previous plugin can't parallelize
        if (!prevPlugin.plugin.metadata.canParallelize) {
          const prevId = operationId(
            distribution,
            prevPlugin.plugin.metadata.id,
            phase,
          );
          if (nodes.has(prevId)) {
            node.dependencies.add(prevId);
            const prevNode = nodes.get(prevId)!;
            prevNode.dependents.add(id);
          }
        }
      }
    }
  }

  // Build edges map for debugging
  for (const [id, node] of nodes) {
    edges.set(id, [...node.dependencies]);
  }

  // Detect cycles using DFS
  const hasCycles = detectCycles(nodes);
  if (hasCycles) {
    throw new GraphError("Cycle detected in plugin dependency graph");
  }

  // Compute execution waves using topological sort
  const waves = computeWaves(nodes);

  return {
    waves,
    totalOperations: nodes.size,
    hasCycles: false,
    edges,
  };
}

/**
 * Detect cycles in the graph using DFS.
 */
function detectCycles(nodes: Map<string, GraphNode>): boolean {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(id: string): boolean {
    visited.add(id);
    recursionStack.add(id);

    const node = nodes.get(id);
    if (!node) return false;

    for (const depId of node.dependencies) {
      if (!visited.has(depId)) {
        if (dfs(depId)) return true;
      } else if (recursionStack.has(depId)) {
        return true; // Cycle detected
      }
    }

    recursionStack.delete(id);
    return false;
  }

  for (const id of nodes.keys()) {
    if (!visited.has(id)) {
      if (dfs(id)) return true;
    }
  }

  return false;
}

/**
 * Compute execution waves using modified Kahn's algorithm.
 * Each wave contains operations that can run in parallel.
 */
function computeWaves(nodes: Map<string, GraphNode>): readonly ExecutionWave[] {
  const waves: ExecutionWave[] = [];
  const inDegree = new Map<string, number>();
  const remaining = new Set<string>();

  // Initialize in-degrees
  for (const [id, node] of nodes) {
    inDegree.set(id, node.dependencies.size);
    remaining.add(id);
  }

  let waveIndex = 0;

  while (remaining.size > 0) {
    // Find all nodes with no remaining dependencies
    const waveOperations: ExecutionOperation[] = [];

    for (const id of remaining) {
      if (inDegree.get(id) === 0) {
        const node = nodes.get(id)!;
        waveOperations.push(node.operation);
      }
    }

    if (waveOperations.length === 0) {
      // This shouldn't happen if we've already checked for cycles
      throw new GraphError("No operations available but remaining set is not empty");
    }

    // Remove processed nodes and update in-degrees
    for (const op of waveOperations) {
      remaining.delete(op.id);
      const node = nodes.get(op.id)!;

      for (const dependentId of node.dependents) {
        const currentDegree = inDegree.get(dependentId) ?? 0;
        inDegree.set(dependentId, currentDegree - 1);
      }
    }

    waves.push({
      index: waveIndex++,
      operations: waveOperations,
    });
  }

  return waves;
}

// =============================================================================
// Graph Execution
// =============================================================================

/**
 * Context factory for creating phase-specific contexts.
 */
export interface ContextFactory {
  createPluginContext(
    operation: ExecutionOperation,
    distConfig: DistConfig,
  ): PluginContext;

  createSetupContext(
    operation: ExecutionOperation,
    distConfig: DistConfig,
  ): SetupContext;

  createReleaseContext(
    operation: ExecutionOperation,
    distConfig: DistConfig,
  ): ReleaseContext;
}

/**
 * Execute an operation graph.
 */
export async function executeGraph(
  graph: ExecutionGraph,
  distConfig: DistConfig,
  contextFactory: ContextFactory,
  onProgress?: (completed: number, total: number, operation: ExecutionOperation) => void,
): Promise<GraphExecutionResult> {
  const startTime = Date.now();
  const results = new Map<string, PluginPhaseResult>();
  const failed: string[] = [];
  let completed = 0;

  for (const wave of graph.waves) {
    // Execute all operations in this wave in parallel
    const wavePromises = wave.operations.map(async (operation) => {
      try {
        const result = await executeOperation(operation, distConfig, contextFactory);
        results.set(operation.id, result);

        if (!result.success) {
          failed.push(operation.id);
        }

        completed++;
        onProgress?.(completed, graph.totalOperations, operation);

        return { id: operation.id, result };
      } catch (error) {
        const errorResult: PluginPhaseResult = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        results.set(operation.id, errorResult);
        failed.push(operation.id);
        completed++;
        onProgress?.(completed, graph.totalOperations, operation);
        return { id: operation.id, result: errorResult };
      }
    });

    // Wait for all operations in this wave to complete
    // This await is intentional - waves must complete sequentially, operations within waves are parallel
    // deno-lint-ignore no-await-in-loop
    await Promise.all(wavePromises);

    // If any operation in this wave failed and it has dependents, we might want to stop
    // For now, we continue to collect all results
  }

  return {
    success: failed.length === 0,
    results,
    failed,
    totalDurationMs: Date.now() - startTime,
  };
}

/**
 * Execute a single operation.
 */
async function executeOperation(
  operation: ExecutionOperation,
  distConfig: DistConfig,
  contextFactory: ContextFactory,
): Promise<PluginPhaseResult> {
  const { plugin, phase } = operation;

  // Get the phase handler
  const handler = plugin[phase];
  if (!handler) {
    return {
      success: true,
      warnings: [`Plugin ${plugin.metadata.id} has no ${phase} handler`],
    };
  }

  // Create the appropriate context based on phase type
  if (phase === "setup") {
    const context = contextFactory.createSetupContext(operation, distConfig);
    return await (handler as Plugin["setup"])!.call(plugin, context);
  }

  if (phase === "release") {
    const context = contextFactory.createReleaseContext(operation, distConfig);
    return await (handler as Plugin["release"])!.call(plugin, context);
  }

  // Build phases
  const context = contextFactory.createPluginContext(operation, distConfig);
  return await (handler as Plugin["transform"])!.call(plugin, context);
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Create a simple text visualization of the execution graph.
 */
export function visualizeGraph(graph: ExecutionGraph): string {
  const lines: string[] = [];

  lines.push(`Execution Graph (${graph.totalOperations} operations, ${graph.waves.length} waves)`);
  lines.push("=".repeat(60));

  for (const wave of graph.waves) {
    lines.push(`\nWave ${wave.index + 1} (${wave.operations.length} operations, parallel):`);

    for (const op of wave.operations) {
      const deps = graph.edges.get(op.id) ?? [];
      const depStr = deps.length > 0 ? ` [depends on: ${deps.join(", ")}]` : "";
      lines.push(`  - ${op.id}${depStr}`);
    }
  }

  return lines.join("\n");
}

/**
 * Get operations for a specific phase.
 */
export function getPhaseOperations(
  graph: ExecutionGraph,
  phase: PhaseId,
): readonly ExecutionOperation[] {
  return graph.waves.flatMap((wave) => wave.operations.filter((op) => op.phase === phase));
}

/**
 * Get operations for a specific distribution.
 */
export function getDistributionOperations(
  graph: ExecutionGraph,
  distribution: string,
): readonly ExecutionOperation[] {
  return graph.waves.flatMap((wave) =>
    wave.operations.filter((op) => op.distribution === distribution)
  );
}

/**
 * Filter a graph to only include specific phases.
 */
export function filterGraphByPhases(
  graph: ExecutionGraph,
  phases: readonly PhaseId[],
): ExecutionGraph {
  const phaseSet = new Set(phases);

  const filteredWaves = graph.waves
    .map((wave, index) => ({
      index,
      operations: wave.operations.filter((op) => phaseSet.has(op.phase)),
    }))
    .filter((wave) => wave.operations.length > 0);

  // Re-index waves
  const reindexedWaves = filteredWaves.map((wave, newIndex) => ({
    ...wave,
    index: newIndex,
  }));

  const totalOperations = reindexedWaves.reduce(
    (sum, wave) => sum + wave.operations.length,
    0,
  );

  // Filter edges to only include relevant operations
  const relevantOps = new Set(
    reindexedWaves.flatMap((wave) => wave.operations.map((op) => op.id)),
  );

  const filteredEdges = new Map<string, string[]>();
  for (const [id, deps] of graph.edges) {
    if (relevantOps.has(id)) {
      filteredEdges.set(
        id,
        deps.filter((dep) => relevantOps.has(dep)),
      );
    }
  }

  return {
    waves: reindexedWaves,
    totalOperations,
    hasCycles: false,
    edges: filteredEdges,
  };
}

/**
 * Merge multiple execution graphs (for different distributions).
 */
export function mergeGraphs(graphs: readonly ExecutionGraph[]): ExecutionGraph {
  if (graphs.length === 0) {
    return {
      waves: [],
      totalOperations: 0,
      hasCycles: false,
      edges: new Map(),
    };
  }

  if (graphs.length === 1) {
    return graphs[0];
  }

  // Collect all nodes and edges
  const allEdges = new Map<string, string[]>();
  const nodes = new Map<string, GraphNode>();

  for (const graph of graphs) {
    for (const wave of graph.waves) {
      for (const op of wave.operations) {
        const deps = [...(graph.edges.get(op.id) ?? [])];
        allEdges.set(op.id, deps);

        nodes.set(op.id, {
          operation: op,
          dependencies: new Set(deps),
          dependents: new Set(),
          processed: false,
        });
      }
    }
  }

  // Rebuild dependents
  for (const [id, node] of nodes) {
    for (const depId of node.dependencies) {
      const depNode = nodes.get(depId);
      if (depNode) {
        depNode.dependents.add(id);
      }
    }
  }

  // Recompute waves
  const waves = computeWaves(nodes);

  return {
    waves,
    totalOperations: nodes.size,
    hasCycles: false,
    edges: allEdges,
  };
}
