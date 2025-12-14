/**
 * @module cli
 *
 * CLI entry point for deno-dist.
 * Provides commands for building distributions, validating config, and updating workflows.
 */

import { parseArgs } from "@std/cli";
import { loadDistConfig, validateConfig } from "./config.ts";
import { runPipeline, runPipelineAll } from "./pipeline.ts";
import type { CliArgs, CliCommand, PipelineOptions } from "./types.ts";

// =============================================================================
// Constants
// =============================================================================

const VERSION = "0.1.0";
const PROGRAM_NAME = "deno-dist";

// =============================================================================
// Help Text
// =============================================================================

const HELP_TEXT = `
${PROGRAM_NAME} v${VERSION}
Universal distribution tool for Deno projects

USAGE:
  deno task dist <command> [options]

COMMANDS:
  build [name]        Build a distribution (or all with --all)
  validate            Validate distribution configuration
  update-workflows    Generate GitHub Actions workflows

OPTIONS:
  -h, --help          Show this help message
  -v, --version       Show version
  --verbose           Enable verbose output
  --clean             Clean output directory before build
  --scope <vars>      Provide template variables (key=value,key2=value2)
  --config <path>     Path to deno.json (default: ./deno.json)
  --all               Build all distributions

EXAMPLES:
  deno task dist build node
  deno task dist build --all --clean
  deno task dist validate
  deno task dist update-workflows
`;

// =============================================================================
// Argument Parsing
// =============================================================================

/**
 * Parse CLI arguments into a structured format.
 */
function parseCliArgs(args: string[]): CliArgs {
  const parsed = parseArgs(args, {
    boolean: ["help", "version", "verbose", "clean", "all"],
    string: ["scope", "config"],
    alias: {
      h: "help",
      v: "version",
    },
    default: {
      config: "deno.json",
    },
  });

  const command = parsed._[0]?.toString() ?? "help";
  const positional = parsed._.slice(1).map(String);

  // Parse scope variables
  const scope: Record<string, string> = {};
  if (parsed.scope) {
    const pairs = parsed.scope.split(",");
    for (const pair of pairs) {
      const [key, value] = pair.split("=");
      if (key && value !== undefined) {
        scope[key.trim()] = value.trim();
      }
    }
  }

  return {
    command,
    positional,
    flags: {
      help: parsed.help ?? false,
      version: parsed.version ?? false,
      verbose: parsed.verbose ?? false,
      clean: parsed.clean ?? false,
      all: parsed.all ?? false,
      config: parsed.config ?? "deno.json",
    },
    scope,
  };
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Build command: Build one or all distributions.
 */
const buildCommand: CliCommand = {
  name: "build",
  description: "Build a distribution (or all with --all)",
  aliases: ["b"],

  async handler(args: CliArgs): Promise<number> {
    const configPath = args.flags.config as string;
    const verbose = args.flags.verbose as boolean;
    const clean = args.flags.clean as boolean;
    const buildAll = args.flags.all as boolean;

    // Load configuration
    let config;
    try {
      config = await loadDistConfig(configPath);
    } catch (error) {
      // deno-lint-ignore no-console
      console.error(`Failed to load config: ${String(error)}`);
      return 1;
    }

    // Validate configuration
    const validation = validateConfig(config);
    if (!validation.valid) {
      // deno-lint-ignore no-console
      console.error("Configuration errors:");
      for (const err of validation.errors) {
        // deno-lint-ignore no-console
        console.error(`  - ${err}`);
      }
      return 1;
    }

    for (const warning of validation.warnings) {
      // deno-lint-ignore no-console
      console.warn(`Warning: ${warning}`);
    }

    const pipelineOptions: PipelineOptions = {
      verbose,
      clean,
      scope: args.scope,
    };

    if (buildAll) {
      // Build all distributions
      const results = await runPipelineAll(config, pipelineOptions);
      const failed = [...results.values()].filter((r) => !r.success);
      return failed.length > 0 ? 1 : 0;
    }

    // Build specific distribution
    const distName = args.positional[0];
    if (!distName) {
      // deno-lint-ignore no-console
      console.error("Error: Distribution name required. Use --all to build all.");
      // deno-lint-ignore no-console
      console.error(`Available distributions: ${Object.keys(config.distributions).join(", ")}`);
      return 1;
    }

    if (!config.distributions[distName]) {
      // deno-lint-ignore no-console
      console.error(`Error: Distribution "${distName}" not found.`);
      // deno-lint-ignore no-console
      console.error(`Available distributions: ${Object.keys(config.distributions).join(", ")}`);
      return 1;
    }

    const result = await runPipeline(distName, config, pipelineOptions);
    return result.success ? 0 : 1;
  },
};

/**
 * Validate command: Validate distribution configuration.
 */
const validateCommand: CliCommand = {
  name: "validate",
  description: "Validate distribution configuration",
  aliases: ["v", "check"],

  async handler(args: CliArgs): Promise<number> {
    const configPath = args.flags.config as string;

    // deno-lint-ignore no-console
    console.log(`Validating configuration: ${configPath}`);

    let config;
    try {
      config = await loadDistConfig(configPath);
    } catch (error) {
      // deno-lint-ignore no-console
      console.error(`Failed to load config: ${String(error)}`);
      return 1;
    }

    const validation = validateConfig(config);

    if (validation.errors.length > 0) {
      // deno-lint-ignore no-console
      console.error("\nErrors:");
      for (const err of validation.errors) {
        // deno-lint-ignore no-console
        console.error(`  \u2717 ${err}`);
      }
    }

    if (validation.warnings.length > 0) {
      // deno-lint-ignore no-console
      console.warn("\nWarnings:");
      for (const warning of validation.warnings) {
        // deno-lint-ignore no-console
        console.warn(`  \u26A0 ${warning}`);
      }
    }

    if (validation.valid) {
      // deno-lint-ignore no-console
      console.log("\n\u2713 Configuration is valid");
      // deno-lint-ignore no-console
      console.log(`  Distributions: ${Object.keys(config.distributions).join(", ") || "(none)"}`);
      // deno-lint-ignore no-console
      console.log(`  Output directory: ${config.distDir}`);
      return 0;
    }

    // deno-lint-ignore no-console
    console.error("\n\u2717 Configuration is invalid");
    return 1;
  },
};

/**
 * Update-workflows command: Generate GitHub Actions workflows.
 */
const updateWorkflowsCommand: CliCommand = {
  name: "update-workflows",
  description: "Generate GitHub Actions workflows",
  aliases: ["workflows", "uw"],

  async handler(args: CliArgs): Promise<number> {
    const configPath = args.flags.config as string;
    const verbose = args.flags.verbose as boolean;

    // deno-lint-ignore no-console
    console.log("Generating GitHub Actions workflows...");

    let config;
    try {
      config = await loadDistConfig(configPath);
    } catch (error) {
      // deno-lint-ignore no-console
      console.error(`Failed to load config: ${String(error)}`);
      return 1;
    }

    const workflowsDir = ".github/workflows";

    // Ensure workflows directory exists
    try {
      await Deno.mkdir(workflowsDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Collect all workflow write operations
    const writeOperations: Array<{ path: string; content: string }> = [];

    for (const [distName, distConfig] of Object.entries(config.distributions)) {
      // Generate test workflow
      const testWorkflow = generateTestWorkflow(distName, distConfig.runtime, distConfig.versions);
      const testWorkflowPath = `${workflowsDir}/test-${distName}.yml`;
      writeOperations.push({ path: testWorkflowPath, content: testWorkflow });

      // Generate publish workflow if publish config exists
      if (distConfig.publish) {
        const publishWorkflow = generatePublishWorkflow(
          distName,
          distConfig.runtime,
          distConfig.publish,
        );
        const publishWorkflowPath = `${workflowsDir}/publish-${distName}.yml`;
        writeOperations.push({ path: publishWorkflowPath, content: publishWorkflow });
      }
    }

    // Write all workflows in parallel
    await Promise.all(
      writeOperations.map((op) => Deno.writeTextFile(op.path, op.content)),
    );

    if (verbose) {
      for (const op of writeOperations) {
        // deno-lint-ignore no-console
        console.log(`  Generated: ${op.path}`);
      }
    }

    const generated = writeOperations.length;

    // deno-lint-ignore no-console
    console.log(`\n\u2713 Generated ${generated} workflow(s)`);
    return 0;
  },
};

/**
 * Help command: Show help text.
 */
const helpCommand: CliCommand = {
  name: "help",
  description: "Show help message",
  aliases: ["h"],

  handler(_args: CliArgs): Promise<number> {
    // deno-lint-ignore no-console
    console.log(HELP_TEXT);
    return Promise.resolve(0);
  },
};

/**
 * Version command: Show version.
 */
const versionCommand: CliCommand = {
  name: "version",
  description: "Show version",
  aliases: [],

  handler(_args: CliArgs): Promise<number> {
    // deno-lint-ignore no-console
    console.log(`${PROGRAM_NAME} v${VERSION}`);
    return Promise.resolve(0);
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
  versions?: readonly string[],
): string {
  const runtimeVersions = versions ?? getDefaultVersions(runtime);
  const setupAction = getSetupAction(runtime);
  const testCommand = getTestCommand(runtime);

  return `# Auto-generated by deno-dist
name: Test ${distName}

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        version: [${runtimeVersions.map((v) => `"${v}"`).join(", ")}]

    steps:
      - uses: actions/checkout@v4

      - name: Setup ${runtime}
        uses: ${setupAction}
        with:
          ${getVersionKey(runtime)}: \${{ matrix.version }}

      - name: Build distribution
        run: deno task dist build ${distName}

      - name: Run tests
        run: ${testCommand}
        working-directory: ./target/${distName}
`;
}

/**
 * Generate a publish workflow for a distribution.
 */
function generatePublishWorkflow(
  distName: string,
  runtime: string,
  publishConfig: { registry?: string; provenance?: boolean },
): string {
  const registry = publishConfig.registry ?? getDefaultRegistry(runtime);
  const provenance = publishConfig.provenance ?? true;

  return `# Auto-generated by deno-dist
name: Publish ${distName}

on:
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Build distribution
        run: deno task dist build ${distName}

      - name: Publish to ${registry}
        run: ${getPublishCommand(runtime, registry, provenance)}
        working-directory: ./target/${distName}
`;
}

/**
 * Get default versions for a runtime.
 */
function getDefaultVersions(runtime: string): string[] {
  switch (runtime) {
    case "deno":
      return ["v2.x"];
    case "node":
      return ["18", "20", "22"];
    case "bun":
      return ["latest"];
    default:
      return ["latest"];
  }
}

/**
 * Get the setup action for a runtime.
 */
function getSetupAction(runtime: string): string {
  switch (runtime) {
    case "deno":
      return "denoland/setup-deno@v2";
    case "node":
      return "actions/setup-node@v4";
    case "bun":
      return "oven-sh/setup-bun@v2";
    default:
      return "actions/setup-node@v4";
  }
}

/**
 * Get the version key for a runtime setup action.
 */
function getVersionKey(runtime: string): string {
  switch (runtime) {
    case "deno":
      return "deno-version";
    case "node":
      return "node-version";
    case "bun":
      return "bun-version";
    default:
      return "node-version";
  }
}

/**
 * Get the test command for a runtime.
 */
function getTestCommand(runtime: string): string {
  switch (runtime) {
    case "deno":
      return "deno test";
    case "node":
      return "npm test";
    case "bun":
      return "bun test";
    default:
      return "npm test";
  }
}

/**
 * Get the default registry for a runtime.
 */
function getDefaultRegistry(runtime: string): string {
  switch (runtime) {
    case "deno":
      return "jsr";
    case "node":
    case "bun":
      return "npm";
    default:
      return "npm";
  }
}

/**
 * Get the publish command for a runtime and registry.
 */
function getPublishCommand(runtime: string, registry: string, provenance: boolean): string {
  if (registry === "jsr") {
    return "deno publish --allow-dirty";
  }

  if (runtime === "node" || runtime === "bun") {
    const provenanceFlag = provenance ? " --provenance" : "";
    return `npm publish --access public${provenanceFlag}`;
  }

  return "npm publish --access public";
}

// =============================================================================
// Command Registry
// =============================================================================

const commands: CliCommand[] = [
  buildCommand,
  validateCommand,
  updateWorkflowsCommand,
  helpCommand,
  versionCommand,
];

/**
 * Find a command by name or alias.
 */
function findCommand(name: string): CliCommand | undefined {
  return commands.find(
    (cmd) => cmd.name === name || cmd.aliases?.includes(name),
  );
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Main CLI entry point.
 */
async function main(): Promise<number> {
  const args = parseCliArgs(Deno.args);

  // Handle global flags
  if (args.flags.help) {
    return await helpCommand.handler(args);
  }

  if (args.flags.version) {
    return await versionCommand.handler(args);
  }

  // Find and run command
  const command = findCommand(args.command);
  if (!command) {
    // deno-lint-ignore no-console
    console.error(`Unknown command: ${args.command}`);
    // deno-lint-ignore no-console
    console.error(`Run "${PROGRAM_NAME} --help" for usage.`);
    return 1;
  }

  return await command.handler(args);
}

// Run CLI
if (import.meta.main) {
  const exitCode = await main();
  Deno.exit(exitCode);
}

export { main, parseCliArgs };
