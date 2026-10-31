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
  transaction, with its own rights check and hooks; `ctx.read(query)` reads in
  that transaction.
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
