# Project setup

`simetra init` connects a project to the installed tools: it links the
package skills into `.agents/skills/` and `.claude/skills/` and writes the MCP
server entry for the chosen agents. Run it from the project root — the
directory the agent starts in, where `metadata/` lives.

```sh
pnpm exec simetra init
pnpm exec simetra init --agents claude,codex,cursor,vscode
pnpm exec simetra init --dry-run
pnpm exec simetra init --check --agents claude,codex
```

- Without `--agents` only Claude Code's `.mcp.json` is written. The skill
  links are made in both skill directories for every agent.
- The links and configs belong in git. In CI run `init --check` with the same
  `--agents`: it exits 1 when a link or an MCP entry is missing or stale, and
  changes nothing.
- `init` never overwrites what it does not own: a skill directory with the
  same name, or a `simetra` MCP entry with another command, is left alone and
  reported as a note. Arguments you add to its own entry — `--read-only`, a
  metadata directory — are kept.
- A config `init` cannot read safely (JSON with comments, an ambiguous TOML
  table) stops the whole run with exit 2; nothing is written.
- After `pnpm up @simetrajs/designer` the links show the new skill content by
  themselves. A new skill or a moved binary is reported by `init --check`;
  run `init` again.
