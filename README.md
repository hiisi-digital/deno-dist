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
- Generate GitHub Actions workflows automatically
- Template your README with runtime-specific content

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
deno-dist build node

# Build all distributions
deno-dist build --all

# With verbose output
deno-dist build node --verbose

# Clean output directory first
deno-dist build node --clean
```

### 3. Validate your configuration

```bash
deno-dist validate
```

### 4. Generate GitHub Actions workflows

```bash
deno-dist update-workflows
```

This generates test and publish workflows for each distribution.

## Configuration

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
| `plugins`      | `string[]`                  | Plugins to apply during transformation |
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
    "env": { "NODE_ENV": "test" }
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

### deno-to-bun

Transforms Deno code for Bun with import remapping and API shims.

### deno-passthrough

Copies Deno code as-is with optional cleanup (strips tests, etc).

## Custom Scripts

Use `@this` in the plugins array to control where your custom scripts run in the pipeline:

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

export async function postprocess(
  context: PluginContext,
): Promise<PluginPhaseResult> {
  context.log.info("Running custom postprocess...");
  return { success: true };
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
import { loadDistConfig, runPipeline, runPipelineAll, validateConfig } from "@hiisi/deno-dist";

const config = await loadDistConfig("./deno.json");

const validation = validateConfig(config);
if (!validation.valid) {
  console.error(validation.errors);
  Deno.exit(1);
}

const result = await runPipeline("node", config, {
  verbose: true,
  clean: true,
});

if (result.success) {
  console.log(`Built to: ${result.outputDir}`);
}
```

## CLI Reference

```
deno-dist v0.2.1

USAGE:
  deno-dist <command> [options]

COMMANDS:
  build [name]        Build a distribution (or all with --all)
  validate            Validate distribution configuration
  update-workflows    Generate GitHub Actions workflows

OPTIONS:
  -h, --help          Show help
  -v, --version       Show version
  --verbose           Verbose output
  --clean             Clean output directory before build
  --scope <vars>      Custom variables (key=value,key2=value2)
  --config <path>     Path to deno.json (default: ./deno.json)
  --all               Build all distributions
```

## Writing Plugins

Plugins can be published as packages. The plugin interface lives in the package's default export:

```typescript
import type { Plugin, PluginContext, PluginPhaseResult } from "@hiisi/deno-dist";

const myPlugin: Plugin = {
  metadata: {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    description: "Does something useful",
    targetRuntime: "node",
  },

  async transform(context: PluginContext): Promise<PluginPhaseResult> {
    context.log.info("Transforming...");
    return { success: true };
  },
};

export default myPlugin;
```

Reference plugins by their JSR/npm specifier in your config:

```json
{
  "plugins": ["jsr:@someone/my-plugin"]
}
```

## Support

Whether you use this project, have learned something from it, or just like it,
please consider supporting it by buying me a coffee, so I can dedicate more time
on open-source projects like this :)

<a href="https://buymeacoffee.com/orgrinrt" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Buy Me A Coffee" style="height: auto !important;width: auto !important;" ></a>

## License

> You can check out the full license [here](https://github.com/hiisi-digital/deno-dist/blob/main/LICENSE)

This project is licensed under the terms of the **Mozilla Public License 2.0**.

`SPDX-License-Identifier: MPL-2.0`
