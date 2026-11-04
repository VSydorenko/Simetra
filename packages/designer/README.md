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
options. Commands that work with the database (`introspect`, `diff`, `plan`,
`apply`, `roles`) take the connection string from `SIMETRA_DATABASE_URL`;
`apply` needs the hash of a reviewed plan file, and `roles` creates the
platform's cluster roles once, before the first `plan`.

## Start a project

```bash
pnpm add simetra
pnpm add -D @simetrajs/designer
pnpm exec simetra init [--agents claude,codex,cursor,vscode]
```

`init` is idempotent and writes only inside the project:

- relative symlinks `.agents/skills/<skill>` and `.claude/skills/<skill>` to
  the skills in `node_modules/@simetrajs/designer/skills/`, so an update of
  the package updates the skills too (on Windows, junctions; a git checkout
  without `core.symlinks` turns the committed links into files, and `init`
  replaces them with junctions);
- the MCP server entry `simetra` for each agent in `--agents` (default:
  `claude`): `.mcp.json`, `.codex/config.toml` (`[mcp_servers.simetra]`),
  `.cursor/mcp.json` or `.vscode/mcp.json`. The server starts as
  `node <path to the installed bin> mcp`.

Another directory or link with the same skill name, and another `simetra`
entry in a config, stay as they are; `init` prints a note. `init --dry-run`
prints the changes without writing; `init --check` exits with code 1 if
`init` would change anything. If `init` refuses, it writes nothing; an I/O
failure in the middle of writing may leave part of the changes done, and
running `init` again completes them.

Commit the links and the configs, and run `simetra init --check` in CI with
the same `--agents`. The server writes metadata by default; to forbid writes,
add `--read-only` to the `args` of the entry by hand. Codex reads
`.codex/config.toml` only in a trusted project. In a monorepo, run `init` in
the root the agent starts from, where the `metadata` directory lives.

## Agent skills

The package ships skills for AI agents working in a Simetra project under
`skills/`: `simetra-metadata` (editing metadata through the tools) and
`simetra-adoption` (bringing an existing database under metadata). They
match the installed version of the tools. `simetra init` links them into the
project for the agents.

## License

[Apache-2.0](https://github.com/VSydorenko/Simetra/blob/main/LICENSE)
