# @hiisi/deno-dist

Universal distribution tool for Deno projects. Produces runtime-optimized distributions from a single Deno codebase. Supports Deno, Node.js, and Bun as target runtimes.

[![JSR](https://jsr.io/badges/@hiisi/deno-dist)](https://jsr.io/@hiisi/deno-dist)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)

## Features

- **Multi-runtime support**: Build for Deno, Node.js, and Bun from a single codebase
- **Plugin system**: Extensible transformation pipeline with built-in and custom plugins
- **Template processing**: Variable substitution and README templating with HTML comment markers
- **Workflow generation**: Automatic GitHub Actions workflow generation for testing and publishing
- **Zero external dependencies**: Standalone tool with no @hiisi package dependencies

## Installation

```bash
# Run directly from JSR
deno run -A jsr:@hiisi/deno-dist/cli build node

# Or add to your deno.json tasks
{
  "tasks": {
    "dist": "deno run -A jsr:@hiisi/deno-dist/cli"
  }
}
```

## Quick Start

### 1. Add distribution configuration to your `deno.json`

```json
{
  "name": "@your-scope/your-package",
  "version": "1.0.0",
  "distDir": "target",
  "dist": {
    "node": {
      "runtime": "node",
      "versions": ["18", "20", "22"],
      "plugins": ["deno-to-node"]
    },
    "bun": {
      "runtime": "bun",
      "versions": ["latest"],
      "plugins": ["deno-to-bun"]
    },
    "deno": {
      "runtime": "deno",
      "versions": ["v2.x"],
      "plugins": ["deno-passthrough"]
    }
  }
}
```

### 2. Build a distribution

```bash
# Build a specific distribution
deno task dist build node

# Build all distributions
deno task dist build --all

# Build with verbose output
deno task dist build node --verbose

# Clean and rebuild
deno task dist build node --clean
```

### 3. Validate your configuration

```bash
deno task dist validate
```

### 4. Generate GitHub Actions workflows

```bash
deno task dist update-workflows
```

This generates:

- `.github/workflows/test-node.yml`
- `.github/workflows/test-bun.yml`
- `.github/workflows/test-deno.yml`
- `.github/workflows/publish-*.yml` (if publish config exists)

## Configuration Reference

### Root-level fields

| Field     | Type     | Default    | Description                            |
| --------- | -------- | ---------- | -------------------------------------- |
| `distDir` | `string` | `"target"` | Output directory for all distributions |
| `dist`    | `object` | `{}`       | Named distribution configurations      |

### Distribution fields

| Field          | Type                        | Description                            |
| -------------- | --------------------------- | -------------------------------------- |
| `runtime`      | `"deno" \| "node" \| "bun"` | Target runtime (required)              |
| `versions`     | `string[]`                  | Runtime versions to test against       |
| `plugins`      | `string[] \| object[]`      | Plugins to apply during transformation |
| `preprocess`   | `string`                    | Path to custom preprocess script       |
| `transform`    | `string`                    | Path to custom transform script        |
| `postprocess`  | `string`                    | Path to custom postprocess script      |
| `templates`    | `Record<string, string>`    | Template file mappings                 |
| `replacements` | `Record<string, string>`    | String replacement patterns            |
| `test`         | `object`                    | Test configuration                     |
| `publish`      | `object`                    | Publish configuration                  |

### Test configuration

```json
{
  "test": {
    "command": "npm test",
    "setup": ["npm install"],
    "timeout": 30000,
    "env": {
      "NODE_ENV": "test"
    }
  }
}
```

### Publish configuration

```json
{
  "publish": {
    "registry": "npm",
    "provenance": true,
    "access": "public"
  }
}
```

## Built-in Plugins

### deno-to-node

Transforms Deno code to Node.js using [dnt](https://github.com/denoland/dnt).

```json
{
  "plugins": [
    {
      "id": "deno-to-node",
      "options": {
        "entryPoint": "mod.ts",
        "declaration": true,
        "esm": true,
        "cjs": true,
        "shims": {
          "deno": "dev"
        }
      }
    }
  ]
}
```

### deno-to-bun

Transforms Deno code for Bun runtime with import remapping and API shims.

```json
{
  "plugins": [
    {
      "id": "deno-to-bun",
      "options": {
        "entryPoint": "mod.ts",
        "bundle": false,
        "generatePackageJson": true
      }
    }
  ]
}
```

### deno-passthrough

Copies Deno code as-is with optional transformations.

```json
{
  "plugins": [
    {
      "id": "deno-passthrough",
      "options": {
        "stripTests": true,
        "copyAssets": true
      }
    }
  ]
}
```

## Custom Scripts

Use the `@this` keyword in the plugins array to control where your custom scripts run:

```json
{
  "dist": {
    "node": {
      "runtime": "node",
      "plugins": ["deno-to-node", "@this"],
      "postprocess": "./scripts/post_node.ts"
    }
  }
}
```

Custom script interface:

```typescript
import type { PluginContext, PluginPhaseResult } from "@hiisi/deno-dist";

export async function postprocess(context: PluginContext): Promise<PluginPhaseResult> {
  context.log.info("Running custom postprocess...");

  // Your custom logic here

  return { success: true };
}
```

## Template Variables

deno-dist supports a powerful template variable system:

| Syntax            | Description                    | Example              |
| ----------------- | ------------------------------ | -------------------- |
| `@{env.VAR}`      | Environment variable           | `@{env.HOME}`        |
| `@{config.field}` | Config value from deno.json    | `@{config.version}`  |
| `@{scope.key}`    | CLI-provided value             | `@{scope.buildDate}` |
| `@{=name}`        | Capture variable (in patterns) | `@{=pkg}/@{=module}` |
| `@{custom}`       | Custom variable                | `@{myVar}`           |

### CLI scope variables

```bash
deno task dist build node --scope "buildDate=2024-01-01,release=stable"
```

## README Templating

Insert dynamic content into your README using HTML comment markers:

### Single insertion

```markdown
<!-- --dist-template: test-results -->
```

### Range replacement

```markdown
<!-- --dist-template: badges @start -->

This content will be replaced

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

## API Usage

```typescript
import { loadDistConfig, runPipeline, runPipelineAll, validateConfig } from "@hiisi/deno-dist";

// Load configuration
const config = await loadDistConfig("./deno.json");

// Validate
const validation = validateConfig(config);
if (!validation.valid) {
  console.error("Errors:", validation.errors);
  Deno.exit(1);
}

// Build a specific distribution
const result = await runPipeline("node", config, {
  verbose: true,
  clean: true,
});

if (result.success) {
  console.log(`Built to: ${result.outputDir}`);
}

// Or build all distributions
const results = await runPipelineAll(config);
```

## CLI Reference

```
deno-dist v0.1.0
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
```

## Writing Custom Plugins

Create a plugin by implementing the `Plugin` interface:

```typescript
import type { Plugin, PluginContext, PluginPhaseResult } from "@hiisi/deno-dist";

const myPlugin: Plugin = {
  metadata: {
    id: "my-plugin",
    name: "My Custom Plugin",
    version: "1.0.0",
    description: "Does something useful",
    targetRuntime: "node",
  },

  async preprocess(context: PluginContext): Promise<PluginPhaseResult> {
    context.log.info("Preprocessing...");
    return { success: true };
  },

  async transform(context: PluginContext): Promise<PluginPhaseResult> {
    context.log.info("Transforming...");
    // Transform files from context.sourceDir to context.outputDir
    return { success: true, affectedFiles: ["output/mod.ts"] };
  },

  async postprocess(context: PluginContext): Promise<PluginPhaseResult> {
    context.log.info("Postprocessing...");
    return { success: true };
  },
};

export default myPlugin;
```

## License

[MPL-2.0](./LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
