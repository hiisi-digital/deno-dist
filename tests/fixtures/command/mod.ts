/**
 * The library half of a package that is also a command.
 *
 * A tool almost always has one. Keeping it here means the fixture exercises the
 * case where `bin` and `exports` name different files, which is the case a
 * distribution gets wrong by pointing the command at whatever the root export
 * happened to be.
 *
 * @module
 */

export { greeting } from "./src/greet.ts";
