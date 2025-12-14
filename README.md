# `deno-dist`

<div align="center" style="text-align: center;">

[![JSR](https://jsr.io/badges/@hiisi/deno-dist)](https://jsr.io/@hiisi/deno-dist)
[![GitHub Issues](https://img.shields.io/github/issues/hiisi-digital/deno-dist.svg)](https://github.com/hiisi-digital/deno-dist/issues)
![License](https://img.shields.io/github/license/hiisi-digital/deno-dist?color=%23009689)

> Build distributions of your Deno project for multiple runtimes from a single codebase.

</div>

## Overview

`deno-dist` helps you produce runtime-specific builds from a Deno codebase. Define your target runtimes in `deno.json`, and the tool handles the transformation, testing, and publishing workflows.

- Build for Deno, Node.js, or Bun
- Use built-in plugins or write your own
- Graph-based parallel execution for faster builds
- Plugin-driven setup (CI workflows) and release (publishing)
- Template your README with runtime-specific content
- JSON schemas for configuration validation

## Installation

```bash
# Install globally
deno install -gAf -n deno-dist jsr:@hiisi/deno-dist/cli

# Then run as
deno-dist build node

# Or run directly without installing
deno run -A jsr:@hiisi/deno-dist/cli build node

# Or add to your deno.json tasks
{
  "tasks": {
    "dist": "deno run -A jsr:@hiisi/deno-dist/cli"
  }
}

# Then run as
deno task dist build node
```

## Quick Start

### 1. Add distribution config to `deno.json`

```json
{
  "name": "@your-scope/your-package",
  "version": "1.0.0",
  "distDir": "target",
  "dist": {
    "node": {
      "runtime": "node",
      "versions": ["18", "20", "22"],
      "plugins": ["deno-to-node", "github-actions"]
    },
    "bun": {
      "runtime": "bun",
      "versions": ["latest"],
      "plugins": ["deno-to-bun", "github-actions"]
    },
    "deno": {
      "runtime": "deno",
      "versions": ["v2.x"],
      "plugins": ["deno-passthrough", "github-actions"]
    }
  }
}
```

### 2. Build a distribution

```bash
# Build a specific distribution
deno-dist build node

# Build all distributions
deno-dist build --all

# Build with graph-based parallel execution
deno-dist graph --all

# With verbose output
deno-dist build node --verbose

# Clean output directory first
deno-dist build node --clean

# Dry run (show what would happen)
deno-dist build node --dry-run
```

### 3. Generate CI workflows

```bash
# Run setup phase to generate workflows
deno-dist setup --all
```

### 4. Publish releases

```bash
# Run release phase
deno-dist release node --tag v1.0.0

# With release notes
deno-dist release node --tag v1.0.0 --notes CHANGELOG.md
```

### 5. Validate your configuration

```bash
deno-dist validate
```

## Configuration

### Root-level fields

| Field      | Type     | Default    | Description                            |
| ---------- | -------- | ---------- | -------------------------------------- |
| `distDir`  | `string` | `"target"` | Output directory for all distributions |
| `dist`     | `object` | `{}`       | Named distribution configurations      |
| `metadata` | `object` | `{}`       | Package metadata including dist config |

### Distribution fields

| Field          | Type                        | Description                            |
| -------------- | --------------------------- | -------------------------------------- |
| `runtime`      | `"deno" \| "node" \| "bun"` | Target runtime (required)              |
| `versions`     | `string[]`                  | Runtime versions to test against       |
| `plugins`      | `string[]`                  | Plugins to apply during transformation |
| `preprocess`   | `string`                    | Path to custom preprocess script       |
| `transform`    | `string`                    | Path to custom transform script        |
| `postprocess`  | `string`                    | Path to custom postprocess script      |
| `setup`        | `string`                    | Path to custom setup script            |
| `release`      | `string`                    | Path to custom release script          |
| `templates`    | `Record<string, string>`    | Template file mappings                 |
| `replacements` | `Record<string, string>`    | String replacement patterns            |
| `test`         | `object`                    | Test configuration                     |
| `publish`      | `object`                    | Publish configuration                  |
| `releaseNotes` | `object`                    | Release notes configuration            |

### Test configuration

```json
{
  "test": {
    "command": "npm test",
    "setup": ["npm install"],
    "timeout": 30000,
    "env": { "NODE_ENV": "test" },
    "enabled": true
  }
}
```

### Publish configuration

```json
{
  "publish": {
    "registries": ["npm", "github-release"],
    "provenance": true,
    "access": "public",
    "dryRun": false
  }
}
```

### Metadata configuration

```json
{
  "metadata": {
    "dist": {
      "scope": {
        "author": "Your Name",
        "year": "2024"
      },
      "defaultPlugins": ["github-actions"],
      "ci": {
        "provider": "github",
        "branchName": "main",
        "testWorkflow": true,
        "releaseWorkflow": true
      }
    }
  }
}
```

## Plugin Phases

Plugins can implement any combination of five phases:

### Build Phases (sequential per plugin)

1. **preprocess** - Prepare the source before transformation
2. **transform** - Main code transformation (e.g., Deno to Node)
3. **postprocess** - Clean up and optimize after transformation

### Lifecycle Phases (independent)

4. **setup** - Generate project files (CI workflows, configs)
5. **release** - Publish to registries (npm, JSR, GitHub Releases)

## Built-in Plugins

### Build Plugins

| Plugin             | Phases                             | Description                          |
| ------------------ | ---------------------------------- | ------------------------------------ |
| `deno-to-node`     | preprocess, transform, postprocess | Transform Deno code to Node.js (dnt) |
| `deno-to-bun`      | preprocess, transform, postprocess | Transform Deno code for Bun          |
| `deno-passthrough` | preprocess, transform, postprocess | Copy Deno code as-is                 |

### Lifecycle Plugins

| Plugin           | Phases | Description                       |
| ---------------- | ------ | --------------------------------- |
| `github-actions` | setup  | Generate GitHub Actions workflows |

## Graph-Based Execution

The `graph` command builds an execution graph and runs operations in parallel where possible:

```bash
# Build all distributions with parallel execution
deno-dist graph --all --verbose
```

The graph engine:

- Analyzes plugin dependencies
- Groups independent operations into parallel waves
- Respects declared dependencies between plugins
- Maintains phase ordering (preprocess -> transform -> postprocess)

## Custom Scripts

Use `@this` in the plugins array to control where your custom scripts run:

```json
{
  "dist": {
    "node": {
      "runtime": "node",
      "plugins": ["deno-to-node", "@this"],
      "postprocess": "./scripts/post_node.ts",
      "setup": "./scripts/setup_node.ts",
      "release": "./scripts/release_node.ts"
    }
  }
}
```

Custom script interface:

```typescript
import type {
  PluginContext,
  PluginPhaseResult,
  ReleaseContext,
  ReleaseResult,
  SetupContext,
  SetupResult,
} from "@hiisi/deno-dist";

// Build phase script
export async function postprocess(
  context: PluginContext,
): Promise<PluginPhaseResult> {
  context.log.info("Running custom postprocess...");
  return { success: true };
}

// Setup phase script
export async function setup(
  context: SetupContext,
): Promise<SetupResult> {
  context.log.info("Running custom setup...");
  return {
    success: true,
    files: [
      { path: ".github/custom.yml", content: "...", action: "create" },
    ],
  };
}

// Release phase script
export async function release(
  context: ReleaseContext,
): Promise<ReleaseResult> {
  context.log.info(`Releasing version ${context.version}...`);
  return {
    success: true,
    registry: "custom",
    publishedVersion: context.version,
  };
}
```

## Template Variables

Template variables use the `@{...}` syntax and can be used in template files and replacement patterns:

| Syntax            | Description                 | Example             |
| ----------------- | --------------------------- | ------------------- |
| `@{env.VAR}`      | Environment variable        | `@{env.HOME}`       |
| `@{config.field}` | Config value from deno.json | `@{config.version}` |
| `@{varName}`      | Custom variable             | `@{buildDate}`      |
| `@{=name}`        | Capture variable (patterns) | `@{=pkg}/@{=mod}`   |

Custom variables can be provided via CLI:

```bash
deno-dist build node --scope "buildDate=2024-01-01,release=stable"
```

Or defined statically in your config under `metadata.dist.scope`:

```json
{
  "metadata": {
    "dist": {
      "scope": {
        "author": "Your Name",
        "year": "2024"
      }
    }
  }
}
```

## README Templating

Insert dynamic content using HTML comment markers:

### Single insertion

```markdown
<!-- --dist-template: test-results -->
```

### Range replacement

```markdown
<!-- --dist-template: badges @start -->

Content to be replaced

<!-- --dist-template: badges @end -->
```

### Template configuration

```json
{
  "templates": {
    "badges": "./templates/badges.md",
    "test-results": "./templates/test-results.md"
  }
}
```

## Programmatic API

```typescript
import {
  buildExecutionGraph,
  loadDistConfig,
  runPipeline,
  runPipelineGraph,
  runRelease,
  runSetup,
  validateConfig,
  visualizeGraph,
} from "@hiisi/deno-dist";

// Load and validate config
const config = await loadDistConfig("./deno.json");
const validation = validateConfig(config);
if (!validation.valid) {
  console.error(validation.errors);
  Deno.exit(1);
}

// Build a single distribution (legacy sequential)
const result = await runPipeline("node", config, {
  verbose: true,
  clean: true,
});

// Build all distributions with graph execution (parallel)
const results = await runPipelineGraph(config, {
  verbose: true,
  clean: true,
});

// Run setup phase only
await runSetup(config);

// Run release phase
await runRelease(config, {
  version: "1.0.0",
  tag: "v1.0.0",
});

// Visualize the execution graph
import { buildExecutionGraph, visualizeGraph } from "@hiisi/deno-dist";
const graph = buildExecutionGraph(plugins, { distributions: ["node", "bun"] });
console.log(visualizeGraph(graph));
```

## CLI Reference

```
deno-dist v0.3.0

USAGE:
  deno-dist <command> [options]

COMMANDS:
  build [name]        Build a distribution (or all with --all)
  setup [name]        Run setup phase (generate workflows, etc.)
  release [name]      Run release phase (publish to registries)
  graph [name]        Build using graph execution (parallel where possible)
  validate            Validate distribution configuration

OPTIONS:
  -h, --help          Show help
  -v, --version       Show version
  --verbose           Verbose output
  --clean             Clean output directory before build
  --dry-run, -n       Show what would be done without making changes
  --scope <vars>      Custom variables (key=value,key2=value2)
  --config <path>     Path to deno.json (default: ./deno.json)
  --all               Process all distributions

RELEASE OPTIONS:
  --tag <tag>         Git tag for release
  --notes <file>      Path to release notes file
```

## Writing Plugins

Plugins can implement any subset of phases. The plugin interface:

```typescript
import type {
  Plugin,
  PluginContext,
  PluginPhaseResult,
  ReleaseContext,
  ReleaseResult,
  SetupContext,
  SetupResult,
} from "@hiisi/deno-dist";

const myPlugin: Plugin = {
  metadata: {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    description: "Does something useful",
    targetRuntime: "node",
    // Declare which phases this plugin implements
    phases: ["transform", "setup", "release"],
    // Declare dependencies on other plugins
    dependencies: ["deno-to-node"],
    // Declare conflicts with other plugins
    conflicts: ["deno-to-bun"],
    // Allow parallel execution with other plugins
    canParallelize: false,
  },

  async transform(context: PluginContext): Promise<PluginPhaseResult> {
    context.log.info("Transforming...");
    return { success: true };
  },

  async setup(context: SetupContext): Promise<SetupResult> {
    context.log.info("Setting up...");
    return {
      success: true,
      files: [
        { path: ".github/workflows/my-workflow.yml", content: "...", action: "create" },
      ],
    };
  },

  async release(context: ReleaseContext): Promise<ReleaseResult> {
    context.log.info(`Releasing ${context.version}...`);
    return {
      success: true,
      registry: "my-registry",
      publishedVersion: context.version,
      url: "https://...",
    };
  },
};

export default myPlugin;
```

Reference plugins by their JSR/npm specifier:

```json
{
  "plugins": ["jsr:@someone/my-plugin"]
}
```

## JSON Schemas

This package includes JSON schemas for configuration validation:

- `schemas/config.schema.json` - Main configuration schema
- `schemas/distribution.schema.json` - Distribution configuration schema
- `schemas/plugin.schema.json` - Plugin metadata schema

## Support

Whether you use this project, have learned something from it, or just like it,
please consider supporting it by buying me a coffee, so I can dedicate more time
on open-source projects like this :)

<a href="https://buymeacoffee.com/orgrinrt" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Buy Me A Coffee" style="height: auto !important;width: auto !important;" ></a>

## License

> You can check out the full license [here](https://github.com/hiisi-digital/deno-dist/blob/main/LICENSE)

This project is licensed under the terms of the **Mozilla Public License 2.0**.

`SPDX-License-Identifier: MPL-2.0`
