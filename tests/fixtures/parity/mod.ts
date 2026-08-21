/**
 * @module parity-fixture
 *
 * A small, dependency-free package the end-to-end tests build for every
 * runtime. Its whole job is to be installed and imported the way a consumer
 * would, so keep it boring: no Deno APIs, no imports outside the package.
 */

export { greet, stats } from "./src/lib.ts";
export type { Stats } from "./src/lib.ts";
