# decorated-fixture

A fixture for deno-dist's own tests: a package whose sources use decorators and
reflect on the metadata the compiler emits for them.

It exists because a package that compiles under deno used to fail under dnt at
every decorated declaration, and one relying on emitted metadata compiled with
the metadata absent.
