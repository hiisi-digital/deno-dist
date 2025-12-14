/**
 * @module cli
 *
 * CLI entry point for deno-dist.
 * Provides commands for building distributions, validating config, and updating workflows.
 */

import { parseArgs } from "@std/cli";
import { loadDistConfig, validateConfig } from "./config.ts";
import { runPipeline, runPipelineAll } from "./pipeline.ts";
import type { CliArgs, CliCommand, PipelineOptions, RuntimeId } from "./types.ts";

// =============================================================================
// Constants
// =============================================================================

const PROGRAM_NAME = "deno-dist";

// Runtime configuration maps - consolidated switch statement logic
const RUNTIME_SETUP_ACTIONS: Readonly<Record<RuntimeId, string>> = {
  deno: "denoland/setup-deno@v2",
  node: "actions/setup-node@v4",
  bun: "oven-sh/setup-bun@v2",
};

const RUNTIME_VERSION_KEYS: Readonly<Record<RuntimeId, string>> = {
  deno: "deno-version",
  node: "node-version",
  bun: "bun-version",
};

const RUNTIME_TEST_COMMANDS: Readonly<Record<RuntimeId, string>> = {
  deno: "deno test",
  node: "npm test",
  bun: "bun test",
};

const RUNTIME_DEFAULT_VERSIONS: Readonly<Record<RuntimeId, readonly string[]>> = {
  deno: ["v2.x"],
  node: ["18", "20", "22"],
  bun: ["latest"],
};

const RUNTIME_DEFAULT_REGISTRIES: Readonly<Record<RuntimeId, string>> = {
  deno: "jsr",
  node: "npm",
  bun: "npm",
};

// =============================================================================
// Version Loading
// =============================================================================

/**
 * Get the package version from deno.json.
 * Falls back to "0.0.0" if not readable.
 */
async function getVersion(): Promise<string> {
  try {
    const moduleUrl = new URL("../deno.json", import.meta.url);
    const content = await Deno.readTextFile(moduleUrl);
    const config = JSON.parse(content) as { version?: string };
    return config.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// =============================================================================
// Logger Utility
// =============================================================================

/**
 * Logger interface for CLI output.
 */
interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Create a console logger.
 */
function createLogger(): Logger {
  return {
    log(message: string): void {
      // deno-lint-ignore no-console
      console.log(message);
    },
    warn(message: string): void {
      // deno-lint-ignore no-console
      console.warn(message);
    },
    error(message: string): void {
      // deno-lint-ignore no-console
      console.error(message);
    },
  };
}

const logger = createLogger();

// =============================================================================
// Help Text
// =============================================================================

/**
 * Generate help text with current version.
 */
function createHelpText(version: string): string {
  return `
${PROGRAM_NAME} v${version}
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
}

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
  const scope = parseScopeString(parsed.scope);

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

/**
 * Parse scope string (key=value,key2=value2) into a record.
 */
function parseScopeString(scopeStr: string | undefined): Record<string, string> {
  const scope: Record<string, string> = {};
  if (!scopeStr) return scope;

  for (const pair of scopeStr.split(",")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      if (key) {
        scope[key] = value;
      }
    }
  }
  return scope;
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

    // Load and validate configuration
    const configResult = await loadAndValidateConfig(configPath);
    if (!configResult.success) {
      return 1;
    }
    const config = configResult.config;

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
      logger.error("Error: Distribution name required. Use --all to build all.");
      logger.error(`Available distributions: ${Object.keys(config.distributions).join(", ")}`);
      return 1;
    }

    if (!config.distributions[distName]) {
      logger.error(`Error: Distribution "${distName}" not found.`);
      logger.error(`Available distributions: ${Object.keys(config.distributions).join(", ")}`);
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

    logger.log(`Validating configuration: ${configPath}`);

    let config;
    try {
      config = await loadDistConfig(configPath);
    } catch (error) {
      logger.error(`Failed to load config: ${String(error)}`);
      return 1;
    }

    const validation = validateConfig(config);

    if (validation.errors.length > 0) {
      logger.error("\nErrors:");
      for (const err of validation.errors) {
        logger.error(`  \u2717 ${err}`);
      }
    }

    if (validation.warnings.length > 0) {
      logger.warn("\nWarnings:");
      for (const warning of validation.warnings) {
        logger.warn(`  \u26A0 ${warning}`);
      }
    }

    if (validation.valid) {
      logger.log("\n\u2713 Configuration is valid");
      logger.log(`  Distributions: ${Object.keys(config.distributions).join(", ") || "(none)"}`);
      logger.log(`  Output directory: ${config.distDir}`);
      return 0;
    }

    logger.error("\n\u2717 Configuration is invalid");
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

    logger.log("Generating GitHub Actions workflows...");

    let config;
    try {
      config = await loadDistConfig(configPath);
    } catch (error) {
      logger.error(`Failed to load config: ${String(error)}`);
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
      const runtime = distConfig.runtime;

      // Generate test workflow
      const testWorkflow = generateTestWorkflow(distName, runtime, distConfig.versions);
      writeOperations.push({
        path: `${workflowsDir}/test-${distName}.yml`,
        content: testWorkflow,
      });

      // Generate publish workflow if publish config exists
      if (distConfig.publish) {
        const publishWorkflow = generatePublishWorkflow(distName, runtime, distConfig.publish);
        writeOperations.push({
          path: `${workflowsDir}/publish-${distName}.yml`,
          content: publishWorkflow,
        });
      }
    }

    // Write all workflows in parallel
    await Promise.all(
      writeOperations.map((op) => Deno.writeTextFile(op.path, op.content)),
    );

    if (verbose) {
      for (const op of writeOperations) {
        logger.log(`  Generated: ${op.path}`);
      }
    }

    logger.log(`\n\u2713 Generated ${writeOperations.length} workflow(s)`);
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

  async handler(_args: CliArgs): Promise<number> {
    const version = await getVersion();
    logger.log(createHelpText(version));
    return 0;
  },
};

/**
 * Version command: Show version.
 */
const versionCommand: CliCommand = {
  name: "version",
  description: "Show version",
  aliases: [],

  async handler(_args: CliArgs): Promise<number> {
    const version = await getVersion();
    logger.log(`${PROGRAM_NAME} v${version}`);
    return 0;
  },
};

// =============================================================================
// Shared Command Helpers
// =============================================================================

/**
 * Result of config loading and validation.
 */
interface ConfigLoadResult {
  success: boolean;
  config: Awaited<ReturnType<typeof loadDistConfig>>;
}

/**
 * Load and validate configuration, logging errors.
 */
async function loadAndValidateConfig(configPath: string): Promise<ConfigLoadResult> {
  let config;
  try {
    config = await loadDistConfig(configPath);
  } catch (error) {
    logger.error(`Failed to load config: ${String(error)}`);
    return { success: false, config: { distDir: "target", distributions: {} } };
  }

  const validation = validateConfig(config);
  if (!validation.valid) {
    logger.error("Configuration errors:");
    for (const err of validation.errors) {
      logger.error(`  - ${err}`);
    }
    return { success: false, config };
  }

  for (const warning of validation.warnings) {
    logger.warn(`Warning: ${warning}`);
  }

  return { success: true, config };
}

// =============================================================================
// Workflow Generation
// =============================================================================

/**
 * Generate a test workflow for a distribution.
 */
function generateTestWorkflow(
  distName: string,
  runtime: RuntimeId,
  versions?: readonly string[],
): string {
  const runtimeVersions = versions ?? RUNTIME_DEFAULT_VERSIONS[runtime] ?? ["latest"];
  const setupAction = RUNTIME_SETUP_ACTIONS[runtime] ?? RUNTIME_SETUP_ACTIONS.node;
  const versionKey = RUNTIME_VERSION_KEYS[runtime] ?? RUNTIME_VERSION_KEYS.node;
  const testCommand = RUNTIME_TEST_COMMANDS[runtime] ?? RUNTIME_TEST_COMMANDS.node;

  const versionsJson = runtimeVersions.map((v) => `"${v}"`).join(", ");

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
        version: [${versionsJson}]

    steps:
      - uses: actions/checkout@v4

      - name: Setup ${runtime}
        uses: ${setupAction}
        with:
          ${versionKey}: \${{ matrix.version }}

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
  runtime: RuntimeId,
  publishConfig: { registry?: string; provenance?: boolean },
): string {
  const registry = publishConfig.registry ?? RUNTIME_DEFAULT_REGISTRIES[runtime] ?? "npm";
  const provenance = publishConfig.provenance ?? true;
  const publishCommand = getPublishCommand(runtime, registry, provenance);

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
        run: ${publishCommand}
        working-directory: ./target/${distName}
`;
}

/**
 * Get the publish command for a runtime and registry.
 */
function getPublishCommand(runtime: RuntimeId, registry: string, provenance: boolean): string {
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

const commands: readonly CliCommand[] = [
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
    logger.error(`Unknown command: ${args.command}`);
    logger.error(`Run "${PROGRAM_NAME} --help" for usage.`);
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
