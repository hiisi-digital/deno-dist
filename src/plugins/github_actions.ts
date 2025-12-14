/**
 * @module github-actions
 *
 * Setup plugin for generating GitHub Actions workflows.
 * This plugin generates test and release workflows for each distribution.
 */

import type { FileOperation, Plugin, PluginMetadata, SetupContext, SetupResult } from "../types.ts";
import { createTimer, failureResult, successResult } from "./utils.ts";

// =============================================================================
// Plugin Metadata
// =============================================================================

const metadata: PluginMetadata = {
  id: "github-actions",
  name: "GitHub Actions",
  version: "0.1.0",
  description: "Generate GitHub Actions workflows for testing and releasing distributions",
  targetRuntime: "any",
  author: "Hiisi Digital",
  license: "MPL-2.0",
  repository: "https://github.com/hiisi-digital/deno-dist",
  phases: ["setup"],
  canParallelize: true,
  tags: ["ci", "github", "workflow", "setup"],
};

// =============================================================================
// Plugin Options
// =============================================================================

/**
 * Options for the github-actions plugin.
 */
export interface GitHubActionsOptions {
  /** Whether to generate test workflows (default: true) */
  readonly generateTests?: boolean;
  /** Whether to generate release workflows (default: true) */
  readonly generateRelease?: boolean;
  /** Main branch name (default: "main") */
  readonly branchName?: string;
  /** Whether to enable concurrency cancellation (default: true) */
  readonly cancelInProgress?: boolean;
  /** Custom workflow name prefix */
  readonly workflowPrefix?: string;
  /** Additional permissions to request */
  readonly permissions?: Record<string, string>;
}

// =============================================================================
// Constants
// =============================================================================

const RUNTIME_SETUP_ACTIONS: Record<string, string> = {
  deno: "denoland/setup-deno@v2",
  node: "actions/setup-node@v4",
  bun: "oven-sh/setup-bun@v2",
};

const RUNTIME_VERSION_KEYS: Record<string, string> = {
  deno: "deno-version",
  node: "node-version",
  bun: "bun-version",
};

const RUNTIME_TEST_COMMANDS: Record<string, string> = {
  deno: "deno task test",
  node: "npm test",
  bun: "bun test",
};

const RUNTIME_DEFAULT_VERSIONS: Record<string, readonly string[]> = {
  deno: ["v2.x"],
  node: ["18", "20", "22"],
  bun: ["latest"],
};

// =============================================================================
// Plugin Implementation
// =============================================================================

/**
 * The github-actions plugin.
 */
const githubActionsPlugin: Plugin = {
  metadata,

  /**
   * Setup phase: Generate GitHub Actions workflow files.
   */
  async setup(context: SetupContext): Promise<SetupResult> {
    const timer = createTimer();
    const files: FileOperation[] = [];
    const warnings: string[] = [];

    context.log.info("Generating GitHub Actions workflows...");

    const options = context.pluginConfig.options as GitHubActionsOptions | undefined;
    const generateTests = options?.generateTests ?? true;
    const generateRelease = options?.generateRelease ?? true;
    const branchName = options?.branchName ?? "main";
    const workflowPrefix = options?.workflowPrefix ?? "";
    const workflowsDir = context.outputPaths.workflowsDir;

    try {
      // Get all distributions for combined workflow generation
      const distributions = Object.entries(context.allDistConfigs.distributions);

      if (distributions.length === 0) {
        warnings.push("No distributions configured - skipping workflow generation");
        return successResult({ durationMs: timer.elapsed(), warnings });
      }

      // Generate test workflow for each runtime
      if (generateTests) {
        for (const [distName, distConfig] of distributions) {
          const workflowName = workflowPrefix
            ? `${workflowPrefix}-test-${distName}.yml`
            : `test-${distName}.yml`;

          const workflowContent = generateTestWorkflow(
            distName,
            distConfig.runtime,
            distConfig.versions ?? RUNTIME_DEFAULT_VERSIONS[distConfig.runtime] ?? [],
            distConfig.test?.command ?? RUNTIME_TEST_COMMANDS[distConfig.runtime],
            distConfig.test?.setup ?? [],
            branchName,
            options,
          );

          files.push({
            path: `${workflowsDir}/${workflowName}`,
            content: workflowContent,
            action: "create",
          });

          context.log.debug(`Generated test workflow: ${workflowName}`);
        }
      }

      // Generate release workflow
      if (generateRelease) {
        const workflowName = workflowPrefix ? `${workflowPrefix}-release.yml` : "release.yml";

        const workflowContent = generateReleaseWorkflow(
          distributions,
          branchName,
          options,
        );

        files.push({
          path: `${workflowsDir}/${workflowName}`,
          content: workflowContent,
          action: "create",
        });

        context.log.debug(`Generated release workflow: ${workflowName}`);
      }

      // Write files if not a dry run
      if (!context.dryRun) {
        // Collect unique directories and create them
        const dirs = new Set(files.map((f) => f.path.substring(0, f.path.lastIndexOf("/"))));
        await Promise.all([...dirs].map((dir) => Deno.mkdir(dir, { recursive: true })));

        // Write all files in parallel
        await Promise.all(
          files.map(async (file) => {
            await Deno.writeTextFile(file.path, file.content);
            context.log.info(`Created: ${file.path}`);
          }),
        );
      } else {
        context.log.info(`Dry run: would create ${files.length} workflow file(s)`);
      }

      context.log.info(`Generated ${files.length} workflow file(s)`);

      return {
        success: true,
        durationMs: timer.elapsed(),
        warnings: warnings.length > 0 ? warnings : undefined,
        files,
      };
    } catch (error) {
      return failureResult(
        `Failed to generate GitHub Actions workflows: ${String(error)}`,
        timer.elapsed(),
      );
    }
  },
};

// =============================================================================
// Workflow Generation
// =============================================================================

/**
 * Generate a test workflow for a distribution.
 */
function generateTestWorkflow(
  distName: string,
  runtime: string,
  versions: readonly string[],
  testCommand: string,
  setupCommands: readonly string[],
  branchName: string,
  options?: GitHubActionsOptions,
): string {
  const setupAction = RUNTIME_SETUP_ACTIONS[runtime] ?? RUNTIME_SETUP_ACTIONS.node;
  const versionKey = RUNTIME_VERSION_KEYS[runtime] ?? "node-version";
  const versionsList = versions.length > 0 ? versions : RUNTIME_DEFAULT_VERSIONS[runtime] ?? [];
  const versionsJson = JSON.stringify([...versionsList]);

  const cancelInProgress = options?.cancelInProgress ?? true;

  let yaml = `# Generated by deno-dist github-actions plugin
# Do not edit manually - run 'deno-dist setup' to regenerate

name: Test ${distName}

on:
  push:
    branches: [${branchName}]
  pull_request:
    branches: [${branchName}]
  workflow_dispatch:

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: ${cancelInProgress}

jobs:
  test:
    name: Test on ${runtime} \${{ matrix.version }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        version: ${versionsJson}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup ${runtime}
        uses: ${setupAction}
        with:
          ${versionKey}: \${{ matrix.version }}
`;

  // Add setup commands
  if (setupCommands.length > 0) {
    yaml += `
      - name: Setup
        run: |
`;
    for (const cmd of setupCommands) {
      yaml += `          ${cmd}\n`;
    }
  }

  // Add test command
  yaml += `
      - name: Run tests
        run: ${testCommand}
`;

  return yaml;
}

/**
 * Generate a release workflow for all distributions.
 */
function generateReleaseWorkflow(
  distributions: readonly [
    string,
    {
      runtime: string;
      publish?: { registries?: readonly unknown[]; registry?: string; provenance?: boolean };
    },
  ][],
  _branchName: string,
  options?: GitHubActionsOptions,
): string {
  const cancelInProgress = options?.cancelInProgress ?? true;
  const additionalPermissions = options?.permissions ?? {};

  let yaml = `# Generated by deno-dist github-actions plugin
# Do not edit manually - run 'deno-dist setup' to regenerate

name: Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run (no actual publish)'
        required: false
        default: false
        type: boolean

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: ${cancelInProgress}

permissions:
  contents: write
  id-token: write
`;

  // Add any additional permissions
  for (const [key, value] of Object.entries(additionalPermissions)) {
    yaml += `  ${key}: ${value}\n`;
  }

  yaml += `
jobs:
`;

  // Generate a job for each distribution
  for (const [distName, distConfig] of distributions) {
    const runtime = distConfig.runtime;
    const setupAction = RUNTIME_SETUP_ACTIONS[runtime] ?? RUNTIME_SETUP_ACTIONS.node;
    const versionKey = RUNTIME_VERSION_KEYS[runtime] ?? "node-version";

    // Determine registry and publish command
    const publish = distConfig.publish;
    const registry = publish?.registry ?? (runtime === "deno" ? "jsr" : "npm");
    const provenance = publish?.provenance ?? true;

    yaml += `
  release-${distName}:
    name: Release ${distName}
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup ${runtime}
        uses: ${setupAction}
        with:
          ${versionKey}: latest
`;

    // Add registry-specific publish steps
    if (registry === "jsr") {
      yaml += `
      - name: Publish to JSR
        if: \${{ !inputs.dry_run }}
        run: deno publish${provenance ? " --provenance" : ""}
`;
    } else if (registry === "npm") {
      yaml += `
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'

      - name: Publish to npm
        if: \${{ !inputs.dry_run }}
        run: npm publish${provenance ? " --provenance" : ""} --access public
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`;
    }

    yaml += `
      - name: Create GitHub Release
        if: \${{ !inputs.dry_run && github.event_name == 'push' }}
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          draft: false
          prerelease: \${{ contains(github.ref, '-') }}
`;
  }

  return yaml;
}

// =============================================================================
// Export
// =============================================================================

export default githubActionsPlugin;
export { githubActionsPlugin };
