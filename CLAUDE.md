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
  difficulty. A named agent (`Agent(subagent_type: "agent-kit:…")`) takes its
  model from its frontmatter in agent-kit: `researcher` and `code-reviewer` are
  Sonnet, `code-review-verifier` is Opus. Raise `code-reviewer` to Opus in the
  Agent call for the `data-layer` lens and for any lens on SQL, locks or rights
  (skill `agent-kit:code-review`).
- **Code research.** One entry point, `orient` (agent-kit): `orient <Symbol>`
  for "where does it live, who calls it" over the `codebase-memory-mcp` graph,
  `orient --map "<topic>"` for docs, `orient --plan <file>` for plan anchors.
  An open question that needs several sources (code, database, library code,
  the web) — skill `agent-kit:research`, agent `agent-kit:researcher`. Role
  matrix (who uses code tooling, who re-checks the plan) — `AGENTS.md`
  § "Code research". Library docs — `context7`; published library code —
  `pkg-src`.
- **Committing agents run sequentially.** Never let two agents that commit
  work on the same checkout at the same time. The same holds for a gate run:
  do not run the gates while an agent edits the checkout, or the result is not
  tied to one commit (the DB guard prints the commit and warns when the tree
  changed during the run).
- **Architectural quality, not workarounds.** Propose solutions with a
  long-term architectural rationale, not short-term hacks.
- **Plans are self-contained.** A plan for implementation in another session
  lists every file, step and acceptance criterion — the executor has none of
  this conversation's context. Use the `agent-kit:plan` skill.

## Behavioural conventions

- **Commits and PRs are the owner's.** Never add `Co-Authored-By: Claude`,
  "Generated with…" or any other trailer (this overrides Claude Code's
  default; `.claude/settings.json` also sets empty attribution). The one
  exception is the author's own DCO `Signed-off-by`, added by `git commit -s`
  under the author's git identity; an agent never adds it on its own or signs
  off for the owner.
- **Commit or push only when the owner explicitly asks.** The owner handing a
  plan to `agent-kit:execute`, or asking to close a merged block
  (`agent-kit:close-block`), counts as the request to commit that work; push
  and PRs still need an explicit ask, and go through `pr-gate`.
  Fix branches start from the current working branch, not `main` (`AGENTS.md`).
- **A discussion (`agent-kit:discuss`) asks only high-level,
  direction-setting questions** via `AskUserQuestion`; secondary details are
  decided by a sensible default without discussion.
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
- 🔴 **Graph questions go through `orient`.** Reviewers and verifiers work
  with `Read` / `Grep` / `Bash`; they may run `orient <Symbol>` only to check
  coverage (a forgotten consumer), not to search.

## agent-kit

The way of working comes from the **agent-kit** plugin (the owner's toolset,
installed per machine); the kit's plugin map lists every stage → skill /
agent / script. The project side is the profile `.agents/kit.profile.json`
(tests, PR, docs, review, research); machine values live in a git-ignored
local profile next to it.

| Stage | Kit part |
| --- | --- |
| discussion, open questions | skills `discuss`, `research` |
| spec, glossary, ADR | skill `spec` |
| plan, plan audit | skills `plan`, `plan-audit` |
| execution | skill `execute` (script `sdd`) |
| review of landed work | skill `code-review`; agents `code-reviewer`, `code-review-verifier`; project criteria — `.agents/review-criteria.md` |
| closing a merged block: live debt, finished plans, references, narration | skill `close-block` |
| status, milestones, bugs, ideas | skill `track` (GitHub) |
| tests, PR, docs, Codex | scripts `run-tests`, `pr-gate`, `doc`, `codex-audit` |

The project has no agents or commands of its own. A gap in the kit goes to agent-kit
through the `agent-kit:kit-contribute` skill, not into a project copy.

## Slash commands

🔴 **Guarantees are set by frontmatter, not by the prompt text.** "Don't write
code" in a command body guarantees nothing. A new project command carries
its guarantees in its own frontmatter; the canon for choosing them:

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

**Expected environment.** The commands and workflow above name these
environment-level dependencies; install them per machine:

| Dependency | Named by | Install |
| --- | --- | --- |
| `agent-kit` plugin and its scripts on `PATH` | § "Workflow", § "agent-kit" above | the owner's toolset, per machine |
| `vitest` skill | test work in `agent-kit:execute` | `npx skills add antfu/skills -g -s vitest -y` |
| `codebase-memory-mcp` | § "MCP" above | user-level binary, installed per machine |

Where a dependency is missing (a fresh clone, a cloud session), work by
`AGENTS.md` alone: its § "Commands and gates" lists what the kit scripts run.

Skills for **consumers** of the platform ship inside their package, versioned
with the code; they are not used when developing the platform itself — the repo
skills above are.
