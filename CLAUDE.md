# CLAUDE.md — Simetra Claude Code guide

@AGENTS.md

> All project rules, conventions and architecture pointers are in `AGENTS.md`;
> the `@AGENTS.md` line above loads it at session start (Claude Code reads
> `CLAUDE.md`, not `AGENTS.md`, so "read it first" would not replace the
> import). This file holds only what is specific to **Claude Code**: workflow,
> subagent orchestration, MCP, memory, commands and skills.

## Workflow

> **⚠️ This section is for the MAIN orchestrating session.** If you are a
> subagent or an agent inside a Workflow that was given a concrete task —
> **ignore the orchestration rules below and do your task directly**, without
> spawning further subagents (unless your prompt explicitly asks for it).
> `CLAUDE.md` is loaded into subagent context too, so these rules are scoped on
> purpose; concrete workflow steps live in the slash commands.

- **Orchestrator + validator.** When a task is complex and you are the main
  session, delegate the work to subagents or a Workflow and personally validate
  every finding and decision instead of doing everything solo. A subagent that
  received a concrete task does the opposite — it does the task itself.
- **Model tiering is mandatory.** Never leave the default model on Workflow
  subagents. Every `agent()` gets an explicit `model` and `effort`:
  recon / collection → **Sonnet**; analysis / verification / synthesis →
  **Opus**; trivial mechanics → low effort. Match agent strength to task
  difficulty.
- **Code research — two surfaces.** Code ("where does it live", "what does a
  change affect") — `codebase-memory-mcp` tools; docs and plan-anchor checks —
  `.agents/skills/codebase-research/scripts/orient` (`--map "<topic>"`,
  `--plan <file>`), which is agent-neutral and works without MCP. Procedure and
  report format — skill `codebase-research`; for large multi-file recon — the
  subagent of the same name (`Agent(subagent_type: "codebase-research")`,
  Sonnet, read-only). Role matrix (who uses code tooling, who re-checks the
  plan) — `AGENTS.md` § "Code research". Library docs — `context7`.
- **Committing agents run sequentially.** Never let two agents that commit
  work on the same checkout at the same time.
- **Architectural quality, not workarounds.** Propose solutions with a
  long-term architectural rationale, not short-term hacks.
- **Plans are self-contained.** A plan for implementation in another session
  lists every file, step and acceptance criterion — the executor has none of
  this conversation's context. Use `superpowers:writing-plans`.

## Behavioural conventions

- **Commits and PRs are the owner's.** Never add `Co-Authored-By: Claude`,
  "Generated with…" or any other trailer (this overrides Claude Code's
  default; `.claude/settings.json` also sets empty attribution).
- **Commit or push only when the owner explicitly asks.** Launching
  `/виконай-задачу` or `/архівуй-виконані-задачі` (owner-only commands) counts
  as the request to commit their work; push and PRs still need an explicit ask.
  Fix branches start from the current working branch, not `main` (`AGENTS.md`).
- **Brainstorming asks only high-level, direction-setting questions** via
  `AskUserQuestion`; secondary details are decided by a sensible default
  without discussion.
- **Reviewing sibling work** (code from a parallel agent in another session):
  skip typecheck/lint/test, focus on the code and its conformance to the spec.

## Memory and context

- **Memory files are local to Claude Code** (`~/.claude/projects/.../memory/`),
  outside git. Other harnesses don't see them, and neither do cloud sessions
  (`claude.ai/code`), which also lack the local code graph. Everything critical
  for the work must live in committed files — `AGENTS.md`, `CLAUDE.md`,
  `docs/`, skills — not only in memory.
- **What belongs in memory:** machine state (local paths), Claude Code tooling
  runbooks, live state of unfinished tasks. Never duplicate facts that already
  live in specs or skills — that is how memory bloats and rots.

## MCP

| Server | Source | Use for |
| --- | --- | --- |
| **codebase-memory-mcp** | user-level binary, outside the repo | Code graph: symbols, `CALLS`/`IMPORTS` edges, blast radius — `search_graph`, `trace_path`, `get_code_snippet`, `query_graph`, `get_architecture`, `search_code`, `check_index_coverage` and others |
| **context7** | claude.ai connector | Current library docs (Zod, TanStack, Vitest, …) |

- The repo is indexed as a codebase-memory project; there is deliberately **no
  `.mcp.json`** in the repo — the server is installed per machine. What the
  graph must not index is listed in `.cbmignore`.
- 🔴 **Among our agents only `codebase-research` gets `codebase-memory-mcp`.**
  `code-review` and `code-review-verifier` work with `Read` / `Grep` / `Bash`.

## Agents (`.claude/agents/`)

| Agent | Role |
| --- | --- |
| `codebase-research` | Read-only recon (Sonnet, plan mode); the only one with the code graph. Use instead of generic Explore when the reading volume is unknown |
| `code-review` | Reviews landed work through one lens chosen by the caller; read-only, finds and proves defects, fixes nothing |
| `code-review-verifier` | Adversarial skeptic: tries to refute one finding against the real code; one finding per call |

## Slash commands (`.claude/commands/`)

| Command | Purpose |
| --- | --- |
| `/виконай-задачу` | Execute a task end to end (required argument: task/plan file): plan check with `orient`, implementation Workflow, legacy cleanup, docs/skills sync, review and verification, ticks in the task file |
| `/перевір-роботу-агента-кодування` | Review landed work — against a task checklist if given, otherwise the current branch; lenses per `code-review`, every finding verified |
| `/discuss` | Architecture discussion without code |
| `/проведи-додаткове-дослідження` | Deep research on the open issues of the conversation |
| `/архівуй-виконані-задачі` | Remove a finished block of tasks/specs/plans and bring the canon to current state: collect live debt, fix links in docs and code comments, strip phase narrative, verify adversarially |

🔴 **Guarantees are set by frontmatter, not by the prompt text.** "Don't write
code" in a command body guarantees nothing. Each command's guarantees are in
its own frontmatter; the canon for choosing them:

| Need | Field |
| --- | --- |
| the command must not write code | `disallowed-tools: Edit Write NotebookEdit` |
| only a human may launch it (destructive or writing) | `disable-model-invocation: true` |
| the command is mechanics, not analysis | `model: sonnet` |
| run the command as a subagent | `context: fork` + `agent: <type>` |

## Skills

Claude Code loads skills automatically by their `description` (listed in the
session's system context). The intent → skill block in `AGENTS.md` is for
harnesses **without** auto-discovery; here it is not the loading mechanism, so
a precise `description` matters more than presence in that block.

🔴 **Skills are split by origin:**

| Where | What | How |
| --- | --- | --- |
| **Repo** (committed) | only Simetra's own skills — knowledge about this code | `.agents/skills/<name>/`, plus a relative symlink `.claude/skills/<name>` → `../../.agents/skills/<name>` |
| **Environment** (outside git) | third-party skills from other repos | `npx skills add <owner>/<repo> -g -s <skill> -y`; update with the same command |

Never commit a third-party skill or a skills lock file. Trade-off, accepted on
purpose: cloud sessions see only repo skills, so third-party ones are
unavailable there — in exchange for a single update channel.

Skills for **consumers** of the platform ship inside the package (`skills/`),
versioned with the code; the repo skills above are for developing the platform
itself.
