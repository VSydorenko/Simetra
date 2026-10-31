# simetra

The core library of [Simetra](https://github.com/VSydorenko/Simetra) — an
open-source platform for business applications described by metadata. An
application declares its objects (catalogs, documents, registers and the rest)
as JSON files, and Simetra derives the mechanical parts from them, starting
with the Postgres schema.

## Status

**Pre-alpha preview.** The API is not stable and changes between minor
versions. This release covers the metamodel, the compiler and the schema
layer; the data runtime, screens and studio are ahead on the
[roadmap](https://github.com/VSydorenko/Simetra/blob/main/docs/ROADMAP.md).

## Install

```bash
npm install simetra
npm install -D @simetrajs/designer   # command line and MCP server
```

Node.js 24 or newer. The package is ESM only.

## Entry points

| Import | What it holds |
| --- | --- |
| `simetra/model` | Zod schemas and types of the metamodel, the kind registry |
| `simetra/compiler` | The compiler: metadata files in, contracts and diagnostics out |
| `simetra/schema` | Desired database state and the schema-engine port |
| `simetra/server` | The command runtime: `createCommandRuntime` over a database port, `fromPgPool` for a `pg` pool |
| `simetra/schemas/*` | JSON Schema files for editor support of metadata files |

Most projects start with the command line from
[`@simetrajs/designer`](https://www.npmjs.com/package/@simetrajs/designer)
rather than with these imports.

## License

[Apache-2.0](https://github.com/VSydorenko/Simetra/blob/main/LICENSE)
