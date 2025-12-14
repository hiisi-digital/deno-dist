/**
 * @module template
 *
 * Template variable parsing and processing for deno-dist.
 * Supports:
 * - Capture variables: @{=varName}
 * - Environment variables: @{env.VAR_NAME}
 * - Config namespace: @{config.field}
 * - CLI scope variables: @{scope.key}
 * - Custom variables: @{customVar}
 *
 * Template markers in files:
 * - Single insertion: <!-- --dist-template: <name> -->
 * - Range replacement: <!-- --dist-template: <name> @start --> ... <!-- --dist-template: <name> @end -->
 */

import type { TemplateInsertionMode, TemplateMarker, TemplateVariables } from "./types.ts";
import { TemplateError } from "./types.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Type of template variable.
 */
export type VariableType = "capture" | "env" | "config" | "custom";

/**
 * Parsed template variable.
 */
export interface ParsedVariable {
  /** Original variable text including delimiters */
  readonly raw: string;
  /** Variable type */
  readonly type: VariableType;
  /** Variable key/name (after the prefix) */
  readonly key: string;
  /** Whether this is a capture variable (has = prefix) */
  readonly isCapture: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Pattern for template variables: @{...} */
const VARIABLE_PATTERN = /@\{([^}]+)\}/g;

/** Pattern for single insertion markers: <!-- --dist-template: name --> */
const SINGLE_MARKER_PATTERN = /<!--\s*--dist-template:\s*([a-zA-Z0-9_-]+)\s*-->/g;

/** Pattern for range start markers: <!-- --dist-template: name @start --> */
const RANGE_START_PATTERN = /<!--\s*--dist-template:\s*([a-zA-Z0-9_-]+)\s+@start\s*-->/g;

/** Pattern for range end markers: <!-- --dist-template: name @end --> */
const RANGE_END_PATTERN = /<!--\s*--dist-template:\s*([a-zA-Z0-9_-]+)\s+@end\s*-->/g;

// =============================================================================
// Variable Creation
// =============================================================================

/**
 * Create a new TemplateVariables object with default empty values.
 *
 * @param options Optional initial values
 * @returns TemplateVariables instance
 */
export function createVariables(options?: {
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  scope?: Record<string, string>;
  captures?: Record<string, string>;
  custom?: Record<string, string>;
}): TemplateVariables {
  return {
    env: options?.env ?? {},
    config: options?.config ?? {},
    captures: options?.captures ?? {},
    custom: options?.custom ?? {},
  };
}

/**
 * Create TemplateVariables from environment, config, and CLI scope.
 *
 * CLI scope values become custom variables.
 *
 * @param config Configuration object (from deno.json)
 * @param scope CLI-provided scope values (become custom variables)
 * @returns TemplateVariables instance
 */
export function createVariablesFromContext(
  config: Record<string, unknown>,
  scope: Record<string, string> = {},
): TemplateVariables {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    env[key] = value;
  }

  // Merge static scope from metadata.dist.scope with CLI-provided scope
  const staticScope = getNestedValue(config, "metadata.dist.scope") as
    | Record<string, string>
    | undefined;
  const custom = { ...staticScope, ...scope };

  return {
    env,
    config,
    captures: {},
    custom,
  };
}

// =============================================================================
// Variable Parsing
// =============================================================================

/**
 * Parse a template variable string into its components.
 *
 * @param variableText The variable text (e.g., "=name", "env.HOME", "config.version")
 * @returns Parsed variable information
 */
export function parseVariable(variableText: string): ParsedVariable {
  const raw = `@{${variableText}}`;

  // Capture variable: =varName
  if (variableText.startsWith("=")) {
    return {
      raw,
      type: "capture",
      key: variableText.slice(1),
      isCapture: true,
    };
  }

  // Environment variable: env.VAR_NAME
  if (variableText.startsWith("env.")) {
    return {
      raw,
      type: "env",
      key: variableText.slice(4),
      isCapture: false,
    };
  }

  // Config namespace: config.field
  if (variableText.startsWith("config.")) {
    return {
      raw,
      type: "config",
      key: variableText.slice(7),
      isCapture: false,
    };
  }

  // Custom variable (no prefix)
  return {
    raw,
    type: "custom",
    key: variableText,
    isCapture: false,
  };
}

/**
 * Find all template variables in a string.
 *
 * @param text Text to search
 * @returns Array of parsed variables
 */
export function findVariables(text: string): readonly ParsedVariable[] {
  const variables: ParsedVariable[] = [];
  const pattern = new RegExp(VARIABLE_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    variables.push(parseVariable(match[1]));
  }

  return variables;
}

// =============================================================================
// Variable Resolution
// =============================================================================

/**
 * Resolve a single variable to its value.
 *
 * @param variable Parsed variable
 * @param variables Variable context
 * @returns Resolved value or undefined if not found
 */
export function resolveVariable(
  variable: ParsedVariable,
  variables: TemplateVariables,
): string | undefined {
  switch (variable.type) {
    case "capture":
      return variables.captures[variable.key];

    case "env":
      return variables.env[variable.key];

    case "config": {
      const value = getNestedValue(variables.config, variable.key);
      return value !== undefined ? String(value) : undefined;
    }

    case "custom":
      return variables.custom[variable.key];
  }
}

/**
 * Get a nested value from an object using dot notation.
 *
 * @param obj Object to get value from
 * @param path Dot-separated path (e.g., "foo.bar.baz")
 * @returns Value at path or undefined
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Resolve all variables in a string, replacing @{...} with their values.
 *
 * @param text Text containing variables
 * @param variables Variable context
 * @param strict If true, throw on unresolved variables
 * @returns Text with variables replaced
 */
export function resolveVariables(
  text: string,
  variables: TemplateVariables,
  strict = false,
): string {
  return text.replace(VARIABLE_PATTERN, (match, variableText: string) => {
    const parsed = parseVariable(variableText);
    const value = resolveVariable(parsed, variables);

    if (value === undefined) {
      if (strict) {
        throw new TemplateError(
          `Unresolved variable: ${match} (type: ${parsed.type}, key: ${parsed.key})`,
        );
      }
      // Leave unresolved variables as-is
      return match;
    }

    return value;
  });
}

// =============================================================================
// Capture Variables
// =============================================================================

/**
 * Extract captures from a source string using a pattern with capture variables.
 *
 * The pattern should contain @{=name} capture markers, which will be converted
 * to regex capture groups. The captured values are returned as a map.
 *
 * @param source Source string to extract from
 * @param pattern Pattern containing capture variables
 * @returns Map of capture name to captured value
 */
export function extractCaptures(
  source: string,
  pattern: string,
): Record<string, string> {
  const captures: Record<string, string> = {};
  const captureNames: string[] = [];

  // First, find all capture variable positions and names
  const capturePattern = /@\{=([^}]+)\}/g;
  const parts: Array<{ type: "literal" | "capture"; value: string }> = [];
  let lastIndex = 0;
  let captureMatch: RegExpExecArray | null;

  while ((captureMatch = capturePattern.exec(pattern)) !== null) {
    // Add literal part before this capture
    if (captureMatch.index > lastIndex) {
      parts.push({
        type: "literal",
        value: pattern.slice(lastIndex, captureMatch.index),
      });
    }
    // Add the capture
    parts.push({ type: "capture", value: captureMatch[1] });
    captureNames.push(captureMatch[1]);
    lastIndex = captureMatch.index + captureMatch[0].length;
  }

  // Add remaining literal part
  if (lastIndex < pattern.length) {
    parts.push({ type: "literal", value: pattern.slice(lastIndex) });
  }

  // Build regex pattern by escaping literals and inserting capture groups
  const regexPattern = parts
    .map((part) => (part.type === "literal" ? escapeRegex(part.value) : "(.+?)"))
    .join("");

  const regex = new RegExp(`^${regexPattern}$`);
  const match = source.match(regex);

  if (match) {
    for (let i = 0; i < captureNames.length; i++) {
      captures[captureNames[i]] = match[i + 1];
    }
  }

  return captures;
}

/**
 * Apply a replacement pattern using captured values.
 *
 * @param pattern Replacement pattern containing @{=name} references
 * @param captures Captured values
 * @returns Resolved replacement string
 */
export function applyCaptures(
  pattern: string,
  captures: Record<string, string>,
): string {
  return pattern.replace(/@\{=([^}]+)\}/g, (_match, name: string) => {
    return captures[name] ?? "";
  });
}

/**
 * Escape special regex characters in a string.
 * Exported for use by plugins and other modules.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// Template Markers
// =============================================================================

/**
 * Find all template markers in a file content.
 *
 * @param content File content to search
 * @returns Array of template markers
 */
export function findTemplateMarkers(content: string): readonly TemplateMarker[] {
  const markers: TemplateMarker[] = [];
  const foundRanges = new Map<string, { start: number; startMarker: string }>();

  // Find range start markers
  let match: RegExpExecArray | null;
  const startPattern = new RegExp(RANGE_START_PATTERN.source, "g");
  while ((match = startPattern.exec(content)) !== null) {
    foundRanges.set(match[1], {
      start: match.index,
      startMarker: match[0],
    });
  }

  // Find range end markers and create range markers
  const endPattern = new RegExp(RANGE_END_PATTERN.source, "g");
  while ((match = endPattern.exec(content)) !== null) {
    const name = match[1];
    const rangeStart = foundRanges.get(name);
    if (rangeStart) {
      markers.push({
        name,
        mode: "range" as TemplateInsertionMode,
        startIndex: rangeStart.start,
        endIndex: match.index + match[0].length,
        markerText: content.slice(rangeStart.start, match.index + match[0].length),
      });
      foundRanges.delete(name);
    }
  }

  // Find single insertion markers (that are not part of ranges)
  const singlePattern = new RegExp(SINGLE_MARKER_PATTERN.source, "g");
  while ((match = singlePattern.exec(content)) !== null) {
    const name = match[1];
    // Check if this is actually a range marker by looking for @start or @end
    const surroundingText = content.slice(
      Math.max(0, match.index - 20),
      match.index + match[0].length + 20,
    );
    if (surroundingText.includes("@start") || surroundingText.includes("@end")) {
      continue;
    }
    // Check if this position overlaps with any range
    const overlapsRange = markers.some(
      (m) => m.mode === "range" && match!.index >= m.startIndex && match!.index < (m.endIndex ?? 0),
    );
    if (!overlapsRange) {
      markers.push({
        name,
        mode: "single" as TemplateInsertionMode,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        markerText: match[0],
      });
    }
  }

  // Sort by start index
  markers.sort((a, b) => a.startIndex - b.startIndex);

  return markers;
}

// =============================================================================
// Template Processing
// =============================================================================

/**
 * Load a template file and resolve its variables.
 *
 * @param path Path to template file
 * @param variables Variable context
 * @returns Processed template content
 */
export async function loadTemplate(
  path: string,
  variables: TemplateVariables,
): Promise<string> {
  try {
    const content = await Deno.readTextFile(path);
    return resolveVariables(content, variables);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new TemplateError(`Template file not found: ${path}`);
    }
    throw new TemplateError(`Failed to load template: ${path} - ${String(error)}`);
  }
}

/**
 * Process a file by replacing template markers with template content.
 *
 * @param content File content containing markers
 * @param templates Map of template name to template content
 * @returns Processed content with templates inserted
 */
export function processTemplate(
  content: string,
  templates: Record<string, string>,
): string {
  const markers = findTemplateMarkers(content);
  if (markers.length === 0) {
    return content;
  }

  // Process markers in reverse order to preserve indices
  let result = content;
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i];
    const templateContent = templates[marker.name];

    if (templateContent === undefined) {
      // Leave marker as-is if template not found
      continue;
    }

    if (marker.mode === "single") {
      // Single insertion: replace the marker with template content
      result = result.slice(0, marker.startIndex) +
        templateContent +
        result.slice(marker.endIndex);
    } else {
      // Range replacement: replace everything between start and end markers
      // Keep the markers but replace content between them
      const startMarkerMatch = result.slice(marker.startIndex).match(
        /<!--\s*--dist-template:\s*[a-zA-Z0-9_-]+\s+@start\s*-->/,
      );
      const endMarkerMatch = result.slice(0, marker.endIndex).match(
        /<!--\s*--dist-template:\s*[a-zA-Z0-9_-]+\s+@end\s*-->[^]*$/,
      );

      if (startMarkerMatch && endMarkerMatch) {
        const startMarkerEnd = marker.startIndex + startMarkerMatch[0].length;
        const endMarkerStart = marker.endIndex! - endMarkerMatch[0].length;

        result = result.slice(0, startMarkerEnd) +
          "\n" +
          templateContent +
          "\n" +
          result.slice(endMarkerStart);
      }
    }
  }

  return result;
}

/**
 * Apply string replacements to content.
 *
 * Supports capture variables in patterns for flexible replacement.
 *
 * @param content Content to process
 * @param replacements Map of match pattern to replacement pattern
 * @param variables Variable context (for captures)
 * @returns Content with replacements applied
 */
export function applyReplacements(
  content: string,
  replacements: Record<string, string>,
  variables: TemplateVariables,
): string {
  let result = content;

  for (const [matchPattern, replacePattern] of Object.entries(replacements)) {
    // First resolve any variables in the patterns themselves
    const resolvedMatch = resolveVariables(matchPattern, variables);
    const resolvedReplace = resolveVariables(replacePattern, variables);

    // Check if patterns contain capture variables
    const hasCaptures = matchPattern.includes("@{=");

    if (hasCaptures) {
      // Use capture-based replacement
      const captures = extractCaptures(result, matchPattern);
      if (Object.keys(captures).length > 0) {
        const replacement = applyCaptures(resolvedReplace, captures);
        // Create a regex from the match pattern to do the replacement
        const regex = new RegExp(
          escapeRegex(matchPattern).replace(/@\{=([^}]+)\}/g, "(.+?)"),
          "g",
        );
        result = result.replace(regex, replacement);
      }
    } else {
      // Simple string replacement
      result = result.split(resolvedMatch).join(resolvedReplace);
    }
  }

  return result;
}
