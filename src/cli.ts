/**
 * @module cli
 *
 * CLI entry point for deno-dist.
 * Provides commands for building distributions, validating config,
 * running setup, and publishing releases.
 */

import { parseArgs } from "@std/cli";
import { loadDistConfig, validateConfig } from "./config.ts";
import {
  type ExtendedPipelineOptions,
  runBuild,
  runPipeline,
  runPipelineAll,
  runRelease,
  runSetup,
} from "./pipeline.ts";
import type { CliArgs, CliCommand, DistConfig, PipelineOptions } from "./types.ts";

// =============================================================================
// Constants
// =============================================================================

const PROGRAM_NAME = "deno-dist";

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
  deno-dist <command> [options]

COMMANDS:
  build [name]        Build a distribution (or all with --all)
  setup [name]        Run setup phase (generate workflows, etc.)
  release [name]      Run release phase (publish to registries)
  validate            Validate distribution configuration
  graph [name]        Build using graph execution (parallel where possible)

OPTIONS:
  -h, --help          Show this help message
  -v, --version       Show version
  --verbose           Enable verbose output
  --clean             Clean output directory before build
  --dry-run           Show what would be done without making changes
  --scope <vars>      Provide template variables (key=value,key2=value2)
  --config <path>     Path to deno.json (default: ./deno.json)
  --all               Process all distributions

RELEASE OPTIONS:
  --tag <tag>         Git tag for release
  --notes <file>      Path to release notes file

EXAMPLES:
  deno-dist build node
  deno-dist build --all --clean
  deno-dist setup --all
  deno-dist release node --tag v1.0.0
  deno-dist validate
  deno-dist graph --all --verbose
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
    boolean: ["help", "version", "verbose", "clean", "all", "dry-run"],
    string: ["scope", "config", "tag", "notes"],
    alias: {
      h: "help",
      v: "version",
      n: "dry-run",
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
      dryRun: parsed["dry-run"] ?? false,
      config: parsed.config ?? "deno.json",
      tag: parsed.tag,
      notes: parsed.notes,
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
// Shared Helpers
// =============================================================================

/**
 * Result of config loading and validation.
 */
interface ConfigLoadResult {
  success: boolean;
  config: DistConfig;
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

/**
 * Get the target distribution(s) from args.
 * Returns null if validation fails.
 */
function getTargetDistributions(
  args: CliArgs,
  config: DistConfig,
): readonly string[] | null {
  const buildAll = args.flags.all as boolean;

  if (buildAll) {
    return Object.keys(config.distributions);
  }

  const distName = args.positional[0];
  if (!distName) {
    logger.error("Error: Distribution name required. Use --all to process all.");
    logger.error(`Available distributions: ${Object.keys(config.distributions).join(", ")}`);
    return null;
  }

  if (!config.distributions[distName]) {
    logger.error(`Error: Distribution "${distName}" not found.`);
    logger.error(`Available distributions: ${Object.keys(config.distributions).join(", ")}`);
    return null;
  }

  return [distName];
}

/**
 * Create pipeline options from CLI args.
 */
function createPipelineOptions(args: CliArgs): PipelineOptions {
  return {
    verbose: args.flags.verbose as boolean,
    clean: args.flags.clean as boolean,
    scope: args.scope,
    dryRun: args.flags.dryRun as boolean,
  };
}

/**
 * Create extended pipeline options from CLI args.
 */
function createExtendedPipelineOptions(args: CliArgs): ExtendedPipelineOptions {
  return {
    ...createPipelineOptions(args),
    tag: args.flags.tag as string | undefined,
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
    const buildAll = args.flags.all as boolean;

    const configResult = await loadAndValidateConfig(configPath);
    if (!configResult.success) {
      return 1;
    }
    const config = configResult.config;

    const pipelineOptions = createPipelineOptions(args);

    if (buildAll) {
      const results = await runPipelineAll(config, pipelineOptions);
      const failed = [...results.values()].filter((r) => !r.success);
      return failed.length > 0 ? 1 : 0;
    }

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
 * Setup command: Run setup phases (generate workflows, etc.).
 */
const setupCommand: CliCommand = {
  name: "setup",
  description: "Run setup phase (generate workflows, etc.)",
  aliases: ["s", "init"],

  async handler(args: CliArgs): Promise<number> {
    const configPath = args.flags.config as string;

    const configResult = await loadAndValidateConfig(configPath);
    if (!configResult.success) {
      return 1;
    }
    const config = configResult.config;

    const targets = getTargetDistributions(args, config);
    if (!targets) {
      return 1;
    }

    logger.log(`Running setup for: ${targets.join(", ")}`);

    const options = createExtendedPipelineOptions(args);
    const results = await runSetup(config, options);

    const failed = [...results.values()].filter((r) => !r.success);
    if (failed.length > 0) {
      logger.error(`Setup failed for ${failed.length} distribution(s)`);
      return 1;
    }

    logger.log("\n[OK] Setup completed successfully");
    return 0;
  },
};

/**
 * Release command: Run release phases (publish to registries).
 */
const releaseCommand: CliCommand = {
  name: "release",
  description: "Run release phase (publish to registries)",
  aliases: ["r", "publish"],

  async handler(args: CliArgs): Promise<number> {
    const configPath = args.flags.config as string;

    const configResult = await loadAndValidateConfig(configPath);
    if (!configResult.success) {
      return 1;
    }
    const config = configResult.config;

    const targets = getTargetDistributions(args, config);
    if (!targets) {
      return 1;
    }

    logger.log(`Running release for: ${targets.join(", ")}`);

    // Load release notes if specified
    let releaseNotes: string | undefined;
    const notesPath = args.flags.notes as string | undefined;
    if (notesPath) {
      try {
        releaseNotes = await Deno.readTextFile(notesPath);
      } catch (error) {
        logger.error(`Failed to read release notes: ${String(error)}`);
        return 1;
      }
    }

    const options: ExtendedPipelineOptions = {
      ...createExtendedPipelineOptions(args),
      releaseNotes,
      runRelease: true,
    };

    const results = await runRelease(config, options);

    const failed = [...results.values()].filter((r) => !r.success);
    if (failed.length > 0) {
      logger.error(`Release failed for ${failed.length} distribution(s)`);
      return 1;
    }

    logger.log("\n[OK] Release completed successfully");
    return 0;
  },
};

/**
 * Graph command: Build using graph-based parallel execution.
 */
const graphCommand: CliCommand = {
  name: "graph",
  description: "Build using graph execution (parallel where possible)",
  aliases: ["g", "parallel"],

  async handler(args: CliArgs): Promise<number> {
    const configPath = args.flags.config as string;

    const configResult = await loadAndValidateConfig(configPath);
    if (!configResult.success) {
      return 1;
    }
    const config = configResult.config;

    logger.log("Building with graph-based parallel execution...");

    const options = createExtendedPipelineOptions(args);
    const results = await runBuild(config, options);

    const failed = [...results.values()].filter((r) => !r.success);
    if (failed.length > 0) {
      logger.error(`Build failed for ${failed.length} distribution(s)`);
      return 1;
    }

    logger.log("\n[OK] Graph build completed successfully");
    return 0;
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
        logger.error(`  [X] ${err}`);
      }
    }

    if (validation.warnings.length > 0) {
      logger.warn("\nWarnings:");
      for (const warning of validation.warnings) {
        logger.warn(`  [!] ${warning}`);
      }
    }

    if (validation.valid) {
      logger.log("\n[OK] Configuration is valid");
      logger.log(`  Distributions: ${Object.keys(config.distributions).join(", ") || "(none)"}`);
      logger.log(`  Output directory: ${config.distDir}`);
      return 0;
    }

    logger.error("\n[X] Configuration is invalid");
    return 1;
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
// Command Registry
// =============================================================================

const commands: readonly CliCommand[] = [
  buildCommand,
  setupCommand,
  releaseCommand,
  graphCommand,
  validateCommand,
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
