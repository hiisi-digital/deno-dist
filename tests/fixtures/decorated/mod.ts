/**
 * A package whose sources use decorators and reflect on their metadata.
 *
 * Both halves matter and they fail differently. `experimentalDecorators` missing
 * is a type error on every decorated declaration, which is loud. Missing
 * `emitDecoratorMetadata` is silent: the code compiles, and the design-time type
 * a framework reflects on is simply absent, so the framework sees `undefined`
 * and guesses.
 *
 * @module
 */

import "reflect-metadata";

const FIELDS = Symbol.for("decorated-fixture.fields");

/** Records the property and the design-time type the compiler emitted for it. */
export function Field(): (target: object, key: string) => void {
  return (target: object, key: string): void => {
    const owner = target.constructor as { [FIELDS]?: Record<string, string> };
    const found = owner[FIELDS] ?? (owner[FIELDS] = {});
    const design = Reflect.getMetadata("design:type", target, key) as
      | { name?: string }
      | undefined;
    found[key] = design?.name ?? "unknown";
  };
}

export class Greeting {
  @Field()
  name!: string;

  @Field()
  times!: number;

  @Field()
  loud!: boolean;
}

/** What the decorators recorded, which is empty without the compiler options. */
export function fieldsOf(cls: unknown): Record<string, string> {
  return (cls as { [FIELDS]?: Record<string, string> })[FIELDS] ?? {};
}
