/**
 * @module codegen
 *
 * Generates TypeScript type definitions from JSON schemas.
 * Run with: deno run -A scripts/codegen.ts
 */

import { parse as parseJsonc } from "@std/jsonc";

// =============================================================================
// Types
// =============================================================================

interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  default?: unknown;
  deprecated?: boolean;
}

interface GeneratorContext {
  indent: number;
  definitions: Map<string, string>;
  generated: Set<string>;
  allDefs: Record<string, JsonSchema>;
}

// =============================================================================
// Schema Loading
// =============================================================================

async function loadSchema(path: string): Promise<JsonSchema> {
  const content = await Deno.readTextFile(path);
  return parseJsonc(content) as JsonSchema;
}

// =============================================================================
// Type Generation
// =============================================================================

function indentStr(ctx: GeneratorContext): string {
  return "  ".repeat(ctx.indent);
}

function toTypeName(schemaId: string): string {
  // Convert kebab-case, snake_case, spaces, or path to PascalCase
  const base = schemaId
    .replace(/\.schema\.json#?$/, "")
    .replace(/.*\//, "")
    // Split on any non-alphanumeric character
    .split(/[-_.\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => {
      // Handle acronyms like CI, ID, etc.
      const acronyms = ["ci", "id", "url", "api", "npm", "jsr"];
      if (acronyms.includes(part.toLowerCase())) {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");

  // Special cases for common names
  const nameMap: Record<string, string> = {
    "DenoDistPluginMetadata": "PluginMetadataSchema",
    "DenoDistDistributionConfiguration": "DistributionConfigSchema",
    "DenoDistConfiguration": "DistConfigSchema",
    "Distribution": "DistributionConfigSchema",
    "Inlinepluginconfig": "InlinePluginConfig",
    "Testconfig": "TestConfigSchema",
    "Publishconfig": "PublishConfigSchema",
    "Registryconfig": "RegistryConfigSchema",
    "Releasenotesconfig": "ReleaseNotesConfigSchema",
    "Ciconfig": "CIConfigSchema",
    "Runtimeid": "RuntimeID",
    "Phaseid": "PhaseID",
    "Pluginreference": "PluginReference",
  };

  return nameMap[base] ?? base;
}

function toPropertyName(name: string): string {
  // Keep property names as-is, but quote if needed
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    return name;
  }
  return `"${name}"`;
}

function generateType(schema: JsonSchema, ctx: GeneratorContext, _parentIsArray = false): string {
  // Handle $ref
  if (schema.$ref) {
    const refPath = schema.$ref;
    if (refPath.startsWith("#/$defs/")) {
      const refName = refPath.replace(/^#\/\$defs\//, "");
      return toTypeName(refName);
    }
    // Handle external schema references (e.g., "distribution.schema.json#")
    if (refPath.includes(".schema.json")) {
      const refName = refPath.replace(/\.schema\.json#?$/, "").replace(/.*\//, "");
      return toTypeName(refName);
    }
    return "unknown";
  }

  // Handle oneOf/anyOf - wrap each type properly
  if (schema.oneOf) {
    const types = schema.oneOf.map((s) => {
      const t = generateType(s, ctx);
      // Wrap complex types in parentheses if needed
      return t;
    });
    return types.join(" | ");
  }
  if (schema.anyOf) {
    const types = schema.anyOf.map((s) => generateType(s, ctx));
    return types.join(" | ");
  }
  if (schema.allOf) {
    const types = schema.allOf.map((s) => generateType(s, ctx));
    return types.join(" & ");
  }

  // Handle enum
  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // Handle const
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }

  // Handle type
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      if (schema.items) {
        if (Array.isArray(schema.items)) {
          return `readonly [${schema.items.map((i) => generateType(i, ctx)).join(", ")}]`;
        }
        const itemType = generateType(schema.items, ctx, true);
        // If the item type is a union, wrap it in parentheses
        if (itemType.includes(" | ") && !itemType.startsWith("(")) {
          return `readonly (${itemType})[]`;
        }
        return `readonly ${itemType}[]`;
      }
      return "readonly unknown[]";
    case "object":
      return generateObjectType(schema, ctx);
    default:
      return "unknown";
  }
}

function generateObjectType(schema: JsonSchema, ctx: GeneratorContext): string {
  if (!schema.properties && schema.additionalProperties) {
    if (typeof schema.additionalProperties === "boolean") {
      return "Record<string, unknown>";
    }
    return `Record<string, ${generateType(schema.additionalProperties, ctx)}>`;
  }

  if (!schema.properties) {
    return "Record<string, unknown>";
  }

  const required = new Set(schema.required ?? []);
  const lines: string[] = ["{"];
  ctx.indent++;

  for (const [name, prop] of Object.entries(schema.properties)) {
    const propName = toPropertyName(name);
    const optional = required.has(name) ? "" : "?";
    const readonly = "readonly ";
    const propType = generateType(prop, ctx);

    if (prop.description) {
      lines.push(`${indentStr(ctx)}/** ${prop.description} */`);
    }
    if (prop.deprecated) {
      lines.push(`${indentStr(ctx)}/** @deprecated */`);
    }
    lines.push(`${indentStr(ctx)}${readonly}${propName}${optional}: ${propType};`);
  }

  ctx.indent--;
  lines.push(`${indentStr(ctx)}}`);

  return lines.join("\n");
}

function generateInterface(
  name: string,
  schema: JsonSchema,
  ctx: GeneratorContext,
): string {
  const lines: string[] = [];

  if (schema.description) {
    lines.push(`/**`);
    lines.push(` * ${schema.description}`);
    lines.push(` */`);
  }

  const typeName = toTypeName(name);
  lines.push(`export interface ${typeName} ${generateType(schema, ctx)}`);

  return lines.join("\n");
}

function generateTypeAlias(
  name: string,
  schema: JsonSchema,
  ctx: GeneratorContext,
): string {
  const lines: string[] = [];

  if (schema.description) {
    lines.push(`/**`);
    lines.push(` * ${schema.description}`);
    lines.push(` */`);
  }

  const typeName = toTypeName(name);
  lines.push(`export type ${typeName} = ${generateType(schema, ctx)};`);

  return lines.join("\n");
}

function generateDefinitions(
  defs: Record<string, JsonSchema>,
  ctx: GeneratorContext,
): string[] {
  const output: string[] = [];

  for (const [name, schema] of Object.entries(defs)) {
    const typeName = toTypeName(name);
    if (ctx.generated.has(typeName)) continue;
    ctx.generated.add(typeName);

    if (schema.type === "object" && schema.properties) {
      output.push(generateInterface(name, schema, ctx));
    } else {
      output.push(generateTypeAlias(name, schema, ctx));
    }
    output.push("");
  }

  return output;
}

async function generateFromSchema(schemaPath: string): Promise<string> {
  const schema = await loadSchema(schemaPath);
  const ctx: GeneratorContext = {
    indent: 0,
    definitions: new Map(),
    generated: new Set(),
    allDefs: schema.$defs ?? {},
  };

  const output: string[] = [];

  // Generate header
  const fileName = schemaPath.split("/").pop() ?? schemaPath;
  output.push(`// =============================================================================`);
  output.push(`// Generated Types from ${fileName}`);
  output.push(`// DO NOT EDIT - This file is auto-generated by scripts/codegen.ts`);
  output.push(`// =============================================================================`);
  output.push("");

  // Generate definitions first
  if (schema.$defs) {
    output.push(...generateDefinitions(schema.$defs, ctx));
  }

  // Generate main type
  if (schema.title) {
    const mainName = schema.title.replace(/\s+Schema$/, "");
    const typeName = toTypeName(mainName);
    if (!ctx.generated.has(typeName)) {
      if (schema.type === "object" && schema.properties) {
        output.push(generateInterface(mainName, schema, ctx));
      } else {
        output.push(generateTypeAlias(mainName, schema, ctx));
      }
    }
  }

  return output.join("\n");
}

// =============================================================================
// Main Generation
// =============================================================================

async function main(): Promise<void> {
  const schemasDir = new URL("../schemas", import.meta.url).pathname;
  const outputPath = new URL("../src/generated_types.ts", import.meta.url).pathname;

  const header = `/**
 * @module generated_types
 *
 * Auto-generated TypeScript types from JSON schemas.
 * DO NOT EDIT MANUALLY - Run \`deno task codegen\` to regenerate.
 *
 * @generated
 */

`;

  const schemaFiles = ["plugin.schema.json", "distribution.schema.json", "config.schema.json"];

  const outputs: string[] = [header];

  // Process schemas in order (they may have dependencies)
  for (const file of schemaFiles) {
    const schemaPath = `${schemasDir}/${file}`;
    try {
      // deno-lint-ignore no-await-in-loop
      const generated = await generateFromSchema(schemaPath);
      outputs.push(generated);
      outputs.push("");
    } catch (error) {
      // deno-lint-ignore no-console
      console.error(`Failed to generate types from ${file}:`, error);
    }
  }

  // Add runtime type guards and constants
  // Note: RuntimeId and PhaseId are already generated from schemas, so we only add
  // additional types and functions here
  outputs.push(`// =============================================================================`);
  outputs.push(`// Type Guards and Constants`);
  outputs.push(`// =============================================================================`);
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Build phase identifiers (operate on code).`);
  outputs.push(` */`);
  outputs.push(`export type BuildPhaseId = "preprocess" | "transform" | "postprocess";`);
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Lifecycle phase identifiers.`);
  outputs.push(` */`);
  outputs.push(`export type LifecyclePhaseId = "setup" | "release";`);
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Target runtime including 'any' for lifecycle-only plugins.`);
  outputs.push(` */`);
  outputs.push(`export type TargetRuntime = RuntimeId | "any";`);
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Check if a value is a valid RuntimeId.`);
  outputs.push(` */`);
  outputs.push(`export function isRuntimeId(value: unknown): value is RuntimeId {`);
  outputs.push(`  return value === "deno" || value === "node" || value === "bun";`);
  outputs.push(`}`);
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Check if a value is a valid PhaseId.`);
  outputs.push(` */`);
  outputs.push(`export function isPhaseId(value: unknown): value is PhaseId {`);
  outputs.push(`  return (`);
  outputs.push(`    value === "preprocess" ||`);
  outputs.push(`    value === "transform" ||`);
  outputs.push(`    value === "postprocess" ||`);
  outputs.push(`    value === "setup" ||`);
  outputs.push(`    value === "release"`);
  outputs.push(`  );`);
  outputs.push(`}`);
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Check if a value is a build phase.`);
  outputs.push(` */`);
  outputs.push(`export function isBuildPhase(value: unknown): value is BuildPhaseId {`);
  outputs.push(
    `  return value === "preprocess" || value === "transform" || value === "postprocess";`,
  );
  outputs.push(`}`);
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Check if a value is a lifecycle phase.`);
  outputs.push(` */`);
  outputs.push(`export function isLifecyclePhase(value: unknown): value is LifecyclePhaseId {`);
  outputs.push(`  return value === "setup" || value === "release";`);
  outputs.push(`}`);
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * All valid runtime identifiers.`);
  outputs.push(` */`);
  outputs.push(
    `export const RUNTIME_IDS: readonly RuntimeId[] = ["deno", "node", "bun"] as const;`,
  );
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * All valid phase identifiers.`);
  outputs.push(` */`);
  outputs.push(
    `export const PHASE_IDS: readonly PhaseId[] = ["preprocess", "transform", "postprocess", "setup", "release"] as const;`,
  );
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Build phases (operate on code).`);
  outputs.push(` */`);
  outputs.push(
    `export const BUILD_PHASE_IDS: readonly BuildPhaseId[] = ["preprocess", "transform", "postprocess"] as const;`,
  );
  outputs.push("");
  outputs.push(`/**`);
  outputs.push(` * Lifecycle phases (setup and release).`);
  outputs.push(` */`);
  outputs.push(
    `export const LIFECYCLE_PHASE_IDS: readonly LifecyclePhaseId[] = ["setup", "release"] as const;`,
  );
  outputs.push("");

  await Deno.writeTextFile(outputPath, outputs.join("\n"));

  // deno-lint-ignore no-console
  console.log(`Generated types written to: ${outputPath}`);
}

// Run if executed directly
if (import.meta.main) {
  await main();
}

export { generateFromSchema, loadSchema };
