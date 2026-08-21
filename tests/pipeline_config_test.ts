/**
 * The config record the manifests are built from survives a jsonc file.
 *
 * The pipeline used to strip jsonc comments with a line-anchored regex before
 * JSON.parse. A `//` inside a string is where that goes wrong, and a config's
 * description or repository field carrying a URL is the ordinary case, not the
 * edge: the strip truncated the line mid-string, the parse failed, a silent
 * catch swallowed it into an empty record, and every manifest built from it
 * shipped as "package" at "0.0.0". @std/jsonc was already in the import map
 * and parses both spellings.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { clearConfigCache, loadConfigAsRecord } from "../src/pipeline.ts";

Deno.test("loadConfigAsRecord", async (t) => {
  await t.step("a jsonc config with a URL in a string survives", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(dir, "deno.jsonc"),
        `{
  // the comment is what makes this jsonc
  "name": "@hiisi/urls-in-strings",
  "version": "1.2.3",
  "description": "docs at https://example.com/here"
}`,
      );
      clearConfigCache();
      const record = await loadConfigAsRecord(join(dir, "deno.json"));
      assertEquals(record["name"], "@hiisi/urls-in-strings");
      assertEquals(record["version"], "1.2.3");
      assertEquals(record["description"], "docs at https://example.com/here");
    } finally {
      clearConfigCache();
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("a plain json config still parses", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        `{ "name": "@hiisi/plain", "version": "0.0.1" }`,
      );
      clearConfigCache();
      const record = await loadConfigAsRecord(join(dir, "deno.json"));
      assertEquals(record["name"], "@hiisi/plain");
    } finally {
      clearConfigCache();
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("a missing config yields an empty record", async () => {
    const dir = await Deno.makeTempDir();
    try {
      clearConfigCache();
      const record = await loadConfigAsRecord(join(dir, "deno.json"));
      assertEquals(record, {});
    } finally {
      clearConfigCache();
      await Deno.remove(dir, { recursive: true });
    }
  });
});
