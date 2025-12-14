/**
 * @module template_test
 *
 * Unit tests for the template parser and processing system.
 */

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  applyCaptures,
  applyReplacements,
  createVariables,
  extractCaptures,
  findTemplateMarkers,
  findVariables,
  parseVariable,
  processTemplate,
  resolveVariable,
  resolveVariables,
} from "../src/template.ts";
import type { TemplateVariables } from "../src/types.ts";

describe("parseVariable", () => {
  it("should parse capture variables", () => {
    const result = parseVariable("=name");
    assertEquals(result.type, "capture");
    assertEquals(result.key, "name");
    assertEquals(result.isCapture, true);
    assertEquals(result.raw, "@{=name}");
  });

  it("should parse environment variables", () => {
    const result = parseVariable("env.HOME");
    assertEquals(result.type, "env");
    assertEquals(result.key, "HOME");
    assertEquals(result.isCapture, false);
  });

  it("should parse config variables", () => {
    const result = parseVariable("config.version");
    assertEquals(result.type, "config");
    assertEquals(result.key, "version");
    assertEquals(result.isCapture, false);
  });

  it("should parse scope variables", () => {
    const result = parseVariable("scope.myKey");
    assertEquals(result.type, "scope");
    assertEquals(result.key, "myKey");
    assertEquals(result.isCapture, false);
  });

  it("should parse custom variables", () => {
    const result = parseVariable("customVar");
    assertEquals(result.type, "custom");
    assertEquals(result.key, "customVar");
    assertEquals(result.isCapture, false);
  });

  it("should handle nested config paths", () => {
    const result = parseVariable("config.package.name");
    assertEquals(result.type, "config");
    assertEquals(result.key, "package.name");
  });
});

describe("findVariables", () => {
  it("should find all variables in text", () => {
    const text = "Hello @{env.USER}, version @{config.version} is ready.";
    const vars = findVariables(text);
    assertEquals(vars.length, 2);
    assertEquals(vars[0].type, "env");
    assertEquals(vars[0].key, "USER");
    assertEquals(vars[1].type, "config");
    assertEquals(vars[1].key, "version");
  });

  it("should return empty array when no variables", () => {
    const text = "No variables here.";
    const vars = findVariables(text);
    assertEquals(vars.length, 0);
  });

  it("should find capture variables", () => {
    const text = "Import @{=package}/@{=module}";
    const vars = findVariables(text);
    assertEquals(vars.length, 2);
    assertEquals(vars[0].isCapture, true);
    assertEquals(vars[0].key, "package");
    assertEquals(vars[1].isCapture, true);
    assertEquals(vars[1].key, "module");
  });
});

describe("createVariables", () => {
  it("should create empty variables by default", () => {
    const vars = createVariables();
    assertEquals(Object.keys(vars.env).length, 0);
    assertEquals(Object.keys(vars.config).length, 0);
    assertEquals(Object.keys(vars.scope).length, 0);
    assertEquals(Object.keys(vars.captures).length, 0);
    assertEquals(Object.keys(vars.custom).length, 0);
  });

  it("should initialize with provided values", () => {
    const vars = createVariables({
      env: { HOME: "/home/user" },
      config: { version: "1.0.0" },
      scope: { key: "value" },
    });
    assertEquals(vars.env["HOME"], "/home/user");
    assertEquals(vars.config["version"], "1.0.0");
    assertEquals(vars.scope["key"], "value");
  });
});

describe("resolveVariable", () => {
  const variables: TemplateVariables = {
    env: { HOME: "/home/user", PATH: "/usr/bin" },
    config: { name: "test-pkg", version: "1.0.0", nested: { value: "deep" } },
    scope: { buildType: "release" },
    captures: { pkg: "lodash" },
    custom: { myVar: "hello" },
  };

  it("should resolve env variables", () => {
    const parsed = parseVariable("env.HOME");
    const result = resolveVariable(parsed, variables);
    assertEquals(result, "/home/user");
  });

  it("should resolve config variables", () => {
    const parsed = parseVariable("config.version");
    const result = resolveVariable(parsed, variables);
    assertEquals(result, "1.0.0");
  });

  it("should resolve scope variables", () => {
    const parsed = parseVariable("scope.buildType");
    const result = resolveVariable(parsed, variables);
    assertEquals(result, "release");
  });

  it("should resolve capture variables", () => {
    const parsed = parseVariable("=pkg");
    const result = resolveVariable(parsed, variables);
    assertEquals(result, "lodash");
  });

  it("should resolve custom variables", () => {
    const parsed = parseVariable("myVar");
    const result = resolveVariable(parsed, variables);
    assertEquals(result, "hello");
  });

  it("should return undefined for missing variables", () => {
    const parsed = parseVariable("env.NONEXISTENT");
    const result = resolveVariable(parsed, variables);
    assertEquals(result, undefined);
  });
});

describe("resolveVariables", () => {
  const variables: TemplateVariables = {
    env: { USER: "testuser" },
    config: { version: "2.0.0" },
    scope: {},
    captures: {},
    custom: {},
  };

  it("should replace all variables in text", () => {
    const text = "Hello @{env.USER}, version @{config.version}";
    const result = resolveVariables(text, variables);
    assertEquals(result, "Hello testuser, version 2.0.0");
  });

  it("should leave unresolved variables unchanged in non-strict mode", () => {
    const text = "Hello @{env.UNKNOWN}";
    const result = resolveVariables(text, variables);
    assertEquals(result, "Hello @{env.UNKNOWN}");
  });

  it("should preserve text without variables", () => {
    const text = "No variables here";
    const result = resolveVariables(text, variables);
    assertEquals(result, "No variables here");
  });
});

describe("extractCaptures", () => {
  it("should extract single capture", () => {
    const source = "lodash";
    const pattern = "@{=pkg}";
    const captures = extractCaptures(source, pattern);
    assertEquals(captures["pkg"], "lodash");
  });

  it("should extract multiple captures", () => {
    const source = "lodash/debounce";
    const pattern = "@{=pkg}/@{=module}";
    const captures = extractCaptures(source, pattern);
    assertEquals(captures["pkg"], "lodash");
    assertEquals(captures["module"], "debounce");
  });

  it("should return empty object when no match", () => {
    const source = "lodash";
    const pattern = "@{=pkg}/@{=module}";
    const captures = extractCaptures(source, pattern);
    assertEquals(Object.keys(captures).length, 0);
  });

  it("should handle patterns with static text", () => {
    const source = "import lodash from 'lodash'";
    const pattern = "import @{=pkg} from '@{=pkg}'";
    const captures = extractCaptures(source, pattern);
    assertEquals(captures["pkg"], "lodash");
  });
});

describe("applyCaptures", () => {
  it("should apply captures to replacement pattern", () => {
    const pattern = "from '@{=pkg}'";
    const captures = { pkg: "lodash" };
    const result = applyCaptures(pattern, captures);
    assertEquals(result, "from 'lodash'");
  });

  it("should handle multiple captures", () => {
    const pattern = "@{=pkg}/@{=module}";
    const captures = { pkg: "lodash", module: "debounce" };
    const result = applyCaptures(pattern, captures);
    assertEquals(result, "lodash/debounce");
  });

  it("should leave missing captures as empty string", () => {
    const pattern = "@{=missing}";
    const captures = {};
    const result = applyCaptures(pattern, captures);
    assertEquals(result, "");
  });
});

describe("findTemplateMarkers", () => {
  it("should find single insertion markers", () => {
    const content = "Before\n<!-- --dist-template: test-results -->\nAfter";
    const markers = findTemplateMarkers(content);
    assertEquals(markers.length, 1);
    assertEquals(markers[0].name, "test-results");
    assertEquals(markers[0].mode, "single");
  });

  it("should find range markers", () => {
    const content = `Before
<!-- --dist-template: section @start -->
Content here
<!-- --dist-template: section @end -->
After`;
    const markers = findTemplateMarkers(content);
    assertEquals(markers.length, 1);
    assertEquals(markers[0].name, "section");
    assertEquals(markers[0].mode, "range");
  });

  it("should find multiple markers", () => {
    const content = `<!-- --dist-template: header -->
Text
<!-- --dist-template: footer -->`;
    const markers = findTemplateMarkers(content);
    assertEquals(markers.length, 2);
    assertEquals(markers[0].name, "header");
    assertEquals(markers[1].name, "footer");
  });

  it("should return empty array when no markers", () => {
    const content = "No markers here";
    const markers = findTemplateMarkers(content);
    assertEquals(markers.length, 0);
  });

  it("should handle hyphenated template names", () => {
    const content = "<!-- --dist-template: test-results-table -->";
    const markers = findTemplateMarkers(content);
    assertEquals(markers.length, 1);
    assertEquals(markers[0].name, "test-results-table");
  });
});

describe("processTemplate", () => {
  it("should replace single insertion markers", () => {
    const content = "Before\n<!-- --dist-template: test -->\nAfter";
    const templates = { test: "INSERTED" };
    const result = processTemplate(content, templates);
    assertEquals(result, "Before\nINSERTED\nAfter");
  });

  it("should leave marker if template not found", () => {
    const content = "<!-- --dist-template: missing -->";
    const templates = {};
    const result = processTemplate(content, templates);
    assertEquals(result, "<!-- --dist-template: missing -->");
  });

  it("should handle multiple templates", () => {
    const content = "<!-- --dist-template: a -->-<!-- --dist-template: b -->";
    const templates = { a: "A", b: "B" };
    const result = processTemplate(content, templates);
    assertEquals(result, "A-B");
  });
});

describe("applyReplacements", () => {
  it("should apply simple string replacements", () => {
    const content = "Hello World";
    const replacements = { Hello: "Hi" };
    const variables = createVariables();
    const result = applyReplacements(content, replacements, variables);
    assertEquals(result, "Hi World");
  });

  it("should apply multiple replacements", () => {
    const content = "foo bar baz";
    const replacements = { foo: "FOO", bar: "BAR" };
    const variables = createVariables();
    const result = applyReplacements(content, replacements, variables);
    assertEquals(result, "FOO BAR baz");
  });

  it("should resolve variables in replacement patterns", () => {
    const content = "version: 1.0.0";
    const replacements = { "version: 1.0.0": "version: @{config.version}" };
    const variables = createVariables({ config: { version: "2.0.0" } });
    const result = applyReplacements(content, replacements, variables);
    assertEquals(result, "version: 2.0.0");
  });
});
