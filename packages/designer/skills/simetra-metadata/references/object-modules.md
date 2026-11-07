# Object modules: TypeScript hooks of a command

How the server code of an application adds behaviour to the generated
commands of an object; the router is `SKILL.md`. The full contract is §6.9 of
the P4 runtime spec in the Simetra repository
(`docs/superpowers/specs/2026-10-26-p4-runtime-design.md`).

## Shape

An object module is a plain object typed by the generated entity type
(`entities.d.ts` from `compile --out`) and keyed by 1C write events:

```ts
import { defineObjectModule } from "simetra/model"
import type { Catalogs } from "./generated/entities" // the compile --out file

export const client = defineObjectModule<Catalogs.Client>({
  beforeWrite({ ctx, draft }) {
    return draft
  },
  onWrite({ ctx, row }) {},
})
```

- `beforeWrite` (1C `ПередЗаписью`) runs before the core function and returns
  the draft `{ values?, tabularSections? }` the phase writes. It never adds
  `id` or `mark`; the runtime checks the returned draft again.
- `onWrite` (1C `ПриЗаписи`) sees the written row in the same transaction.
  The row has the shape of a card read: the tabular sections that the phase
  wrote are under `row.tabularSections.<name>`.
- Both run on the operations `create`, `update` and `markDeletion`;
  `delete` raises no module event. On `markDeletion` the draft is empty and
  the mark is `ctx.mark`.
- The host passes modules to `createCommandRuntime` (`simetra/server`) as
  `objectModules`, keyed `"<Kind>.<Name>"` (`"Catalog.Client"`). An unknown
  object or hook key fails runtime creation, not the first command.

## The context

- `ctx.action` is the operation (`create`, `update`, `markDeletion`),
  `ctx.isNew` is `create`; `ctx.user` is the current user.
- `ctx.additionalProperties` is shared by the hooks of one phase only.
- `ctx.run(operation)` runs a phase of another object in the same
  transaction, with its own rights check and hooks, and returns the written
  row in the same shape as `onWrite` sees it; `ctx.read(query)` reads in
  that transaction. It takes the query of `data-read` and returns `{ rows }`
  or `{ count, capped? }`, e.g.
  `ctx.read({ object, where: { attribute: "code", op: "eq", value }, limit: 1 })`.
- A tabular section array in an `update` passed to `ctx.run` replaces the
  section: every existing row must be in the array or in `deleteIds`,
  otherwise the command fails with `command.invalid`
  `reason: "tabular-rows-missing"` — the same rule as `data-command`.
  `ctx.run` always checks this. Build the array from a `ctx.read` of the
  owner's lines.
- One command transaction may start at most `BATCH_MAX` phases through
  `ctx.run`; past it the command fails with `command.depth`
  `reason: "phases"`. Nesting deeper than the runtime's depth limit is
  `command.depth` too.
- Hook time counts toward the command's time budget: a command past it
  fails with `command.timeout`, and a lock wait past the lock timeout with
  `command.busy`. Keep hooks short.
- `ctx.reject(code, path?)` fails the command with `command.rejected`.
- A `ctx` method works only while its hook runs. Never keep `ctx` for later:
  a late call fails the command (`command.internal`).
- A failure the hook catches still fails the command; await every `ctx.run`.

## No external I/O in a hook

A serialization failure or a deadlock reruns the whole transaction, hooks
included. A hook never calls HTTP, mail or a queue outside the database. Put
such work into `ctx.afterCommit(fn)`: it runs after `COMMIT`, at most once,
and only for non-critical work (a crash after `COMMIT` loses it); its error
does not undo the command. On a serverless host, pass `defer` (`waitUntil`) to
`createCommandRuntime`, or `run` waits for this work before it returns.

A hook gets no database client and no SQL text. A row rule that must hold for
every writer belongs in the database (`EventSubscription`, row rules, rights),
not in a hook.
