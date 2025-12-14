/**
 * @module config_test
 *
 * Unit tests for the config parser and validator.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { loadDistConfig, parseDistConfig, validateConfig } from "../src/config.ts";
import { ConfigError } from "../src/types.ts";

describe("parseDistConfig", () => {
  it("should parse empty config", () => {
    const content = "{}";
    const config = parseDistConfig(content);
    assertEquals(config.distDir, "target");
    assertEquals(Object.keys(config.distributions).length, 0);
  });

  it("should parse distDir", () => {
    const content = JSON.stringify({ distDir: "build" });
    const config = parseDistConfig(content);
    assertEquals(config.distDir, "build");
  });

  it("should use default distDir when not specified", () => {
    const content = JSON.stringify({});
    const config = parseDistConfig(content);
    assertEquals(config.distDir, "target");
  });

  it("should parse single distribution", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "node",
          versions: ["18", "20"],
        },
      },
    });
    const config = parseDistConfig(content);
    assertEquals(Object.keys(config.distributions).length, 1);
    assertEquals(config.distributions["node"].runtime, "node");
    assertEquals(config.distributions["node"].versions, ["18", "20"]);
  });

  it("should parse multiple distributions", () => {
    const content = JSON.stringify({
      dist: {
        node: { runtime: "node" },
        bun: { runtime: "bun" },
        deno: { runtime: "deno" },
      },
    });
    const config = parseDistConfig(content);
    assertEquals(Object.keys(config.distributions).length, 3);
    assertEquals(config.distributions["node"].runtime, "node");
    assertEquals(config.distributions["bun"].runtime, "bun");
    assertEquals(config.distributions["deno"].runtime, "deno");
  });

  it("should parse plugins as strings", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "node",
          plugins: ["deno-to-node", "@this"],
        },
      },
    });
    const config = parseDistConfig(content);
    assertEquals(config.distributions["node"].plugins, ["deno-to-node", "@this"]);
  });

  it("should parse plugins as objects", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "node",
          plugins: [
            { id: "deno-to-node", options: { esm: true } },
          ],
        },
      },
    });
    const config = parseDistConfig(content);
    const plugins = config.distributions["node"].plugins!;
    assertEquals(plugins.length, 1);
    assertEquals(typeof plugins[0], "object");
    assertEquals((plugins[0] as { id: string }).id, "deno-to-node");
  });

  it("should parse custom script paths", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "node",
          preprocess: "./scripts/pre.ts",
          transform: "./scripts/transform.ts",
          postprocess: "./scripts/post.ts",
        },
      },
    });
    const config = parseDistConfig(content);
    assertEquals(config.distributions["node"].preprocess, "./scripts/pre.ts");
    assertEquals(config.distributions["node"].transform, "./scripts/transform.ts");
    assertEquals(config.distributions["node"].postprocess, "./scripts/post.ts");
  });

  it("should parse templates", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "node",
          templates: {
            header: "./templates/header.md",
            footer: "./templates/footer.md",
          },
        },
      },
    });
    const config = parseDistConfig(content);
    assertEquals(config.distributions["node"].templates, {
      header: "./templates/header.md",
      footer: "./templates/footer.md",
    });
  });

  it("should parse replacements", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "node",
          replacements: {
            "jsr:@std/path": "node:path",
            "Deno.env": "process.env",
          },
        },
      },
    });
    const config = parseDistConfig(content);
    assertEquals(config.distributions["node"].replacements, {
      "jsr:@std/path": "node:path",
      "Deno.env": "process.env",
    });
  });

  it("should parse test config", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "node",
          test: {
            command: "npm test",
            setup: ["npm install"],
            timeout: 30000,
            env: { NODE_ENV: "test" },
          },
        },
      },
    });
    const config = parseDistConfig(content);
    assertEquals(config.distributions["node"].test?.command, "npm test");
    assertEquals(config.distributions["node"].test?.setup, ["npm install"]);
    assertEquals(config.distributions["node"].test?.timeout, 30000);
    assertEquals(config.distributions["node"].test?.env, { NODE_ENV: "test" });
  });

  it("should parse publish config", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "node",
          publish: {
            registry: "npm",
            provenance: true,
            access: "public",
            command: "npm publish",
          },
        },
      },
    });
    const config = parseDistConfig(content);
    assertEquals(config.distributions["node"].publish?.registry, "npm");
    assertEquals(config.distributions["node"].publish?.provenance, true);
    assertEquals(config.distributions["node"].publish?.access, "public");
    assertEquals(config.distributions["node"].publish?.command, "npm publish");
  });

  it("should throw on invalid JSON", () => {
    const content = "{ invalid json }";
    assertThrows(
      () => parseDistConfig(content),
      ConfigError,
    );
  });

  it("should throw on missing runtime", () => {
    const content = JSON.stringify({
      dist: {
        node: {},
      },
    });
    assertThrows(
      () => parseDistConfig(content),
      ConfigError,
      'must have a "runtime" field',
    );
  });

  it("should throw on invalid runtime", () => {
    const content = JSON.stringify({
      dist: {
        node: {
          runtime: "invalid",
        },
      },
    });
    assertThrows(
      () => parseDistConfig(content),
      ConfigError,
      "invalid runtime",
    );
  });
});

describe("validateConfig", () => {
  it("should validate empty distributions with warning", () => {
    const config = { distDir: "target", distributions: {} };
    const result = validateConfig(config);
    assertEquals(result.valid, true);
    assertEquals(result.warnings.length, 1);
    assertEquals(result.warnings[0], "No distributions defined");
  });

  it("should validate valid config", () => {
    const config = {
      distDir: "target",
      distributions: {
        node: {
          runtime: "node" as const,
          versions: ["18", "20"],
          plugins: ["deno-to-node", "@this"],
          transform: "./transform.ts",
        },
      },
    };
    const result = validateConfig(config);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
  });

  it("should error on empty distDir", () => {
    const config = { distDir: "", distributions: {} };
    const result = validateConfig(config);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e) => e.includes("distDir cannot be empty")), true);
  });

  it("should error on absolute distDir", () => {
    const config = { distDir: "/absolute/path", distributions: {} };
    const result = validateConfig(config);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e) => e.includes("relative path")), true);
  });

  it("should warn on distDir with ..", () => {
    const config = { distDir: "../outside", distributions: {} };
    const result = validateConfig(config);
    assertEquals(result.valid, true);
    assertEquals(result.warnings.some((w) => w.includes("..")), true);
  });

  it("should warn on non-kebab-case distribution name", () => {
    const config = {
      distDir: "target",
      distributions: {
        NodeJS: { runtime: "node" as const },
      },
    };
    const result = validateConfig(config);
    assertEquals(result.warnings.some((w) => w.includes("kebab-case")), true);
  });

  it("should error on invalid runtime in validation", () => {
    const config = {
      distDir: "target",
      distributions: {
        test: { runtime: "invalid" as "node" },
      },
    };
    const result = validateConfig(config);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e) => e.includes("invalid runtime")), true);
  });

  it("should warn on empty versions array", () => {
    const config = {
      distDir: "target",
      distributions: {
        node: { runtime: "node" as const, versions: [] },
      },
    };
    const result = validateConfig(config);
    assertEquals(result.warnings.some((w) => w.includes("versions array is empty")), true);
  });

  it("should warn on @this without custom scripts", () => {
    const config = {
      distDir: "target",
      distributions: {
        node: {
          runtime: "node" as const,
          plugins: ["deno-to-node", "@this"],
        },
      },
    };
    const result = validateConfig(config);
    assertEquals(
      result.warnings.some((w) => w.includes("@this") && w.includes("no custom")),
      true,
    );
  });

  it("should warn on custom scripts without @this", () => {
    const config = {
      distDir: "target",
      distributions: {
        node: {
          runtime: "node" as const,
          plugins: ["deno-to-node"],
          transform: "./transform.ts",
        },
      },
    };
    const result = validateConfig(config);
    assertEquals(
      result.warnings.some((w) => w.includes("custom scripts") && w.includes("@this not in")),
      true,
    );
  });

  it("should warn on non-.ts or .js script paths", () => {
    const config = {
      distDir: "target",
      distributions: {
        node: {
          runtime: "node" as const,
          transform: "./transform.py",
        },
      },
    };
    const result = validateConfig(config);
    assertEquals(result.warnings.some((w) => w.includes(".ts or .js file")), true);
  });

  it("should error on empty template path", () => {
    const config = {
      distDir: "target",
      distributions: {
        node: {
          runtime: "node" as const,
          templates: { header: "" },
        },
      },
    };
    const result = validateConfig(config);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e) => e.includes("empty path")), true);
  });

  it("should error on negative test timeout", () => {
    const config = {
      distDir: "target",
      distributions: {
        node: {
          runtime: "node" as const,
          test: { timeout: -1 },
        },
      },
    };
    const result = validateConfig(config);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e) => e.includes("negative")), true);
  });
});

describe("loadDistConfig", () => {
  it("should throw on non-existent file", async () => {
    try {
      await loadDistConfig("./nonexistent.json");
      throw new Error("Should have thrown");
    } catch (error) {
      assertEquals(error instanceof ConfigError, true);
      assertEquals((error as ConfigError).message.includes("not found"), true);
    }
  });
});
