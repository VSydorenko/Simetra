# @simetrajs/designer

Developer tools for [Simetra](https://github.com/VSydorenko/Simetra) projects:
the `simetra` command line and an MCP server over one catalog of tools. Both
call the same compiler from [`simetra`](https://www.npmjs.com/package/simetra),
so an AI agent and a human get the same checks and the same diagnostics.

## Status

**Pre-alpha preview.** Commands, their options and the metadata format change
between minor versions.

## Install

```bash
npm install simetra
npm install -D @simetrajs/designer
```

Node.js 24 or newer.

## Use

```bash
npx simetra compile metadata         # diagnostics for a metadata directory
npx simetra fix metadata             # assign ids, physical names and $schema
npx simetra explain Catalog.Currency metadata
npx simetra mcp metadata             # the same tools over MCP (stdio)
```

`simetra --help` lists every command, and `simetra <command> --help` its
options. Commands that read the database (`introspect`, `diff`, `plan`,
`apply`) take the connection string from `SIMETRA_DATABASE_URL`; `apply`
needs the hash of a reviewed plan file.

## Agent skills

The package ships skills for AI agents working in a Simetra project under
`skills/`: `simetra-metadata` (editing metadata through the tools) and
`simetra-adoption` (bringing an existing database under metadata). They
match the installed version of the tools.

## License

[Apache-2.0](https://github.com/VSydorenko/Simetra/blob/main/LICENSE)
