/**
 * @module template
 *
 * Template variable parsing and processing for deno-dist.
 * Supports:
 * - Capture variables: @{=varName}
 * - Environment variables: @{env.VAR_NAME}
 * - Config namespace: @{config.field}
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
// Constants - Pre-compiled Regex Patterns
// =============================================================================

/** Pattern for template variables: @{...} */
const VARIABLE_PATTERN = /@\{([^}]+)\}/g;

/** Quick check pattern for variable presence (non-capturing, faster) */
const HAS_VARIABLE_PATTERN = /@\{/;

/** Pattern for single insertion markers: <!-- --dist-template: name --> */
const SINGLE_MARKER_PATTERN = /<!--\s*--dist-template:\s*([a-zA-Z0-9_-]+)\s*-->/g;

/** Pattern for range start markers: <!-- --dist-template: name @start --> */
const RANGE_START_PATTERN = /<!--\s*--dist-template:\s*([a-zA-Z0-9_-]+)\s+@start\s*-->/g;

/** Pattern for range end markers: <!-- --dist-template: name @end --> */
const RANGE_END_PATTERN = /<!--\s*--dist-template:\s*([a-zA-Z0-9_-]+)\s+@end\s*-->/g;

/** Pattern for capture variables in patterns */
const CAPTURE_PATTERN = /@\{=([^}]+)\}/g;

/** Characters that need escaping in regex */
const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

// =============================================================================
// Memoization Cache
// =============================================================================

/** Cache for parsed variables to avoid repeated parsing */
const parseVariableCache = new Map<string, ParsedVariable>();

/** Maximum cache size to prevent unbounded memory growth */
const MAX_CACHE_SIZE = 1000;

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
  // Merge static scope from metadata.dist.scope with CLI-provided scope
  const staticScope = getNestedValue(config, "metadata.dist.scope") as
    | Record<string, string>
    | undefined;

  return {
    env: Deno.env.toObject(),
    config,
    captures: {},
    custom: { ...staticScope, ...scope },
  };
}

// =============================================================================
// Variable Parsing
// =============================================================================

/** Prefix constants for variable types */
const PREFIX_ENV = "env.";
const PREFIX_CONFIG = "config.";

/**
 * Parse a template variable string into its components.
 * Results are memoized for performance.
 *
 * @param variableText The variable text (e.g., "=name", "env.HOME", "config.version")
 * @returns Parsed variable information
 */
export function parseVariable(variableText: string): ParsedVariable {
  // Check cache first
  const cached = parseVariableCache.get(variableText);
  if (cached) {
    return cached;
  }

  const raw = `@{${variableText}}`;
  let result: ParsedVariable;

  // Capture variable: =varName
  if (variableText.startsWith("=")) {
    result = { raw, type: "capture", key: variableText.slice(1), isCapture: true };
  } // Environment variable: env.VAR_NAME
  else if (variableText.startsWith(PREFIX_ENV)) {
    result = { raw, type: "env", key: variableText.slice(PREFIX_ENV.length), isCapture: false };
  } // Config namespace: config.field
  else if (variableText.startsWith(PREFIX_CONFIG)) {
    result = {
      raw,
      type: "config",
      key: variableText.slice(PREFIX_CONFIG.length),
      isCapture: false,
    };
  } // Custom variable (no prefix)
  else {
    result = { raw, type: "custom", key: variableText, isCapture: false };
  }

  // Cache the result (with size limit)
  if (parseVariableCache.size < MAX_CACHE_SIZE) {
    parseVariableCache.set(variableText, result);
  }

  return result;
}

/**
 * Clear the parse variable cache. Useful for testing.
 */
export function clearParseVariableCache(): void {
  parseVariableCache.clear();
}

/**
 * Find all template variables in a string.
 *
 * @param text Text to search
 * @returns Array of parsed variables
 */
export function findVariables(text: string): readonly ParsedVariable[] {
  const variables: ParsedVariable[] = [];
  // Reset lastIndex for global regex reuse
  VARIABLE_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = VARIABLE_PATTERN.exec(text)) !== null) {
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
    if (current === null || current === undefined || typeof current !== "object") {
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
  // Fast path: if no variables present, return as-is
  if (!HAS_VARIABLE_PATTERN.test(text)) {
    return text;
  }

  // Reset lastIndex for global regex
  VARIABLE_PATTERN.lastIndex = 0;

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
  const parts: Array<{ type: "literal" | "capture"; value: string }> = [];

  // Reset lastIndex for global regex reuse
  CAPTURE_PATTERN.lastIndex = 0;

  let lastIndex = 0;
  let captureMatch: RegExpExecArray | null;

  while ((captureMatch = CAPTURE_PATTERN.exec(pattern)) !== null) {
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

  // If no captures found, return empty
  if (captureNames.length === 0) {
    return captures;
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
  return pattern.replace(CAPTURE_PATTERN, (_match, name: string) => {
    return captures[name] ?? "";
  });
}

/**
 * Escape special regex characters in a string.
 * Exported for use by plugins and other modules.
 */
export function escapeRegex(text: string): string {
  return text.replace(REGEX_ESCAPE_PATTERN, "\\$&");
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
  const rangeMarkers = findRangeMarkers(content);
  // Add range markers
  markers.push(...rangeMarkers);

  // Find single insertion markers (that are not part of ranges)
  findSingleMarkers(content, markers);

  // Sort by start index
  markers.sort((a, b) => a.startIndex - b.startIndex);

  return markers;
}

/**
 * Find range markers (start/end pairs).
 */
function findRangeMarkers(content: string): TemplateMarker[] {
  const markers: TemplateMarker[] = [];
  const rangeStarts = new Map<string, { start: number; startMarker: string }>();

  // Reset patterns
  RANGE_START_PATTERN.lastIndex = 0;
  RANGE_END_PATTERN.lastIndex = 0;

  // Find range start markers
  let match: RegExpExecArray | null;
  while ((match = RANGE_START_PATTERN.exec(content)) !== null) {
    rangeStarts.set(match[1], {
      start: match.index,
      startMarker: match[0],
    });
  }

  // Find range end markers and create range markers
  while ((match = RANGE_END_PATTERN.exec(content)) !== null) {
    const name = match[1];
    const rangeStart = rangeStarts.get(name);
    if (rangeStart) {
      markers.push({
        name,
        mode: "range" as TemplateInsertionMode,
        startIndex: rangeStart.start,
        endIndex: match.index + match[0].length,
        markerText: content.slice(rangeStart.start, match.index + match[0].length),
      });
      rangeStarts.delete(name);
    }
  }

  return markers;
}

/**
 * Find single insertion markers that don't overlap with ranges.
 */
function findSingleMarkers(
  content: string,
  markers: TemplateMarker[],
): void {
  SINGLE_MARKER_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SINGLE_MARKER_PATTERN.exec(content)) !== null) {
    const name = match[1];
    const index = match.index;

    // Skip if this is part of a range (name matches a range name)
    // Check surrounding text for @start or @end keywords
    const surroundingText = content.slice(
      Math.max(0, index - 20),
      index + match[0].length + 20,
    );
    if (surroundingText.includes("@start") || surroundingText.includes("@end")) {
      continue;
    }

    // Skip if this position overlaps with any existing range marker
    const overlapsRange = markers.some(
      (m) => m.mode === "range" && index >= m.startIndex && index < (m.endIndex ?? 0),
    );
    if (overlapsRange) {
      continue;
    }

    markers.push({
      name,
      mode: "single" as TemplateInsertionMode,
      startIndex: index,
      endIndex: index + match[0].length,
      markerText: match[0],
    });
  }
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
      result = processRangeMarker(result, marker, templateContent);
    }
  }

  return result;
}

/**
 * Process a range marker replacement.
 */
function processRangeMarker(
  content: string,
  marker: TemplateMarker,
  templateContent: string,
): string {
  // Find where the start marker ends
  const startMarkerMatch = content.slice(marker.startIndex).match(
    /<!--\s*--dist-template:\s*[a-zA-Z0-9_-]+\s+@start\s*-->/,
  );
  // Find where the end marker starts
  const endMarkerMatch = content.slice(0, marker.endIndex).match(
    /<!--\s*--dist-template:\s*[a-zA-Z0-9_-]+\s+@end\s*-->[^]*$/,
  );

  if (startMarkerMatch && endMarkerMatch) {
    const startMarkerEnd = marker.startIndex + startMarkerMatch[0].length;
    const endMarkerStart = marker.endIndex! - endMarkerMatch[0].length;

    return content.slice(0, startMarkerEnd) +
      "\n" +
      templateContent +
      "\n" +
      content.slice(endMarkerStart);
  }

  return content;
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
      result = applyCaptureReplacement(result, matchPattern, resolvedReplace);
    } else {
      // Simple string replacement using split/join for efficiency
      result = result.split(resolvedMatch).join(resolvedReplace);
    }
  }

  return result;
}

/**
 * Apply a capture-based replacement.
 */
function applyCaptureReplacement(
  content: string,
  matchPattern: string,
  replacePattern: string,
): string {
  const captures = extractCaptures(content, matchPattern);
  if (Object.keys(captures).length === 0) {
    return content;
  }

  const replacement = applyCaptures(replacePattern, captures);
  // Create a regex from the match pattern to do the replacement
  const regex = new RegExp(
    escapeRegex(matchPattern).replace(/@\\\{=([^}]+)\\\}/g, "(.+?)"),
    "g",
  );
  return content.replace(regex, replacement);
}
