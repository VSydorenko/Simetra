# SQL trust boundary

What application SQL may do around the tables of a kind, and how to fix each
refusal; the router is `SKILL.md`. Every diagnostic below carries a hint with
the exact allowlist: read it, do not reword the statement until it passes.

Contents:

- Policies and triggers on a table of a kind
- Writes to a table of a kind
- Function bodies
- Code that runs inside a command
- Reading `sql.head-not-allowed`
- Session settings
- Other paths into a command
- Before a promotion

## Policies and triggers on a table of a kind

Only the platform attaches policies and triggers to a table of a kind (and to
its tabular sections), in any `.sql` file, shared `sql/` folder included.
A verbatim `CREATE POLICY` or `CREATE TRIGGER` there is the error
`sql.kind-table-verbatim`, and the unit can never be listed in
`sql-debt.json`. A hand-written policy would open rows past the rights, a
hand-written trigger would act inside every command. Use what replaces them:

- a policy → a right: a role's `grant` (with an extent), `ownership`,
  `access` or `publicRead` on the object;
- a trigger → an `EventSubscription` with a handler that only checks (below).

The same statement on a `CustomTable` is ordinary SQL debt until the table is
promoted into a kind.

## Writes to a table of a kind

Only commands write a table of a kind: write a change of its rows as a
command of the object or its TypeScript hook. No application SQL, in any
file and in debt too, writes one: an `INSERT`, `UPDATE`, `DELETE` or `MERGE`
in a function or procedure body whose target is a table of a kind, a tabular
section, a view of the model over one, or the provider's account table
(`auth.users`) is `sql.kind-table-verbatim` with the form `functionBody`, also
inside a literal `EXECUTE`, a `DO` block or a function the body creates.
Reading the table (`SELECT`, `FOR UPDATE`, `UPDATE … FROM`, `MERGE … USING`)
and `LOCK` are fine. An unqualified table name counts in every schema,
because the body may run with any `search_path`: qualify the names of your
own tables. Such a function is never debt.

## Function bodies

The body of any function or procedure, in any file and in debt too, runs only
the statements the hint of `sql.function-body-statement` lists; the field
`statement` names the one refused. A body never changes the schema: move DDL
into metadata or a migration.

- `nonLiteralExecute`, `dynamicText` (a call of a builtin or provider
  function that executes SQL text, such as `query_to_xml` or `dblink`) and
  `language` (a language other than `sql` and `plpgsql`) cannot be judged:
  rewrite the function with static SQL or remove it. Partition maintenance or
  statistics through `EXECUTE format(…)` is refused on adoption for the same
  reason.
- `unread`: the compiler could not read part of the body; simplify it.
- A temporary table of the body is `CREATE TEMP TABLE … ON COMMIT DROP`, and
  every later reference to it (`DROP`, DML, a read) is `pg_temp.<name>`: an
  unqualified name could hit a table of the same name in your schema.

Application SQL anywhere (a body, a view, a policy, a domain `CHECK`, a
default) calls only the platform and generated functions that read, such as
`simetra.current_user_id()`; calling another one is
`sql.platform-function-call`. Run the write through a command instead.

The shell of every judged function (volatility, `SECURITY`, `search_path`,
`SET` options) is read from its `CREATE FUNCTION`. A separate
`ALTER FUNCTION` that changes it is refused
(`sql.function-settings-shell`, `RESET ALL` included): move the option into
`CREATE FUNCTION` and remove the `ALTER FUNCTION` statement.

## Code that runs inside a command

Kind module functions, subscription handlers, scope set functions, access
dimension value functions and movement query blocks run in the middle of a
command or a policy. The compiler judges them, and every function of the
model they call, by an allowlist (`sql.head-not-allowed`):

- **A handler only checks.** It reads with `SELECT … INTO`, assigns fields of
  `NEW`, raises errors and returns `NEW` or `NULL`. It writes no table and runs
  no `EXECUTE`, `CALL`, `SET` or cursor. A `beforeWrite` handler on a provider
  table (`auth.users`) does not assign `NEW` either. A write the handler did
  belongs to a command or a TypeScript hook.
- **Everything else is a query function.** `LANGUAGE sql`, a string body of
  exactly one `SELECT` (no `INTO`, no `FOR UPDATE`, no data-modifying `WITH`),
  `SET search_path = ''` and no other `SET` option. It reads only qualified
  tables of kinds, adopted tables and views of the model, and calls only query
  functions of the model, generated functions that read,
  `simetra.current_user_id()`, the listed provider functions and allowlisted
  builtins. A function of a kind module that is not of this form belongs in
  a shared `sql/` file, called by nothing inside a command.

## Reading `sql.head-not-allowed`

The diagnostic names the head, the chain from the head to the construct, and
`construct` (with `detail`: the statement kind, function or relation):

| `construct` | Fix |
| --- | --- |
| `call` | Schema-qualify the call, or replace it with an allowlisted builtin, a query function or a reading function of the platform |
| `unqualified` | Qualify the name: `pg_catalog.<name>` for a builtin in a view or a policy, `<schema>.<name>` for your own relation or function |
| `relation` | Read a table of a kind, an adopted table or a view of the model instead |
| `statement` | Move the write, `EXECUTE`, `CALL` or `SET` into a command or a TypeScript hook |
| `query` | Make the body one plain `SELECT` |
| `language`, `searchPath`, `setting`, `sqlBody` | Fix the shell: `LANGUAGE sql`, `SET search_path = ''`, no other `SET` option, an `AS $$ … $$` body |
| `operator` | Use an operator of `pg_catalog` |
| `unread` | Simplify the part the compiler could not read |

## Session settings

- Any application SQL unit (subscription handlers wherever they live,
  object-module functions, and every statement of shared `sql/` files:
  functions, `ALTER FUNCTION`, views, domains, aggregates, policies) must not
  change the platform's session settings — `simetra.*`, the request claims
  (`request.jwt.*`), `session_replication_role` and the role (`SET ROLE`,
  `SET SESSION AUTHORIZATION` and their `RESET`) — in any form (`set_config`
  however it is qualified, `SET`/`RESET`, a function option, a write to
  `pg_settings` or a view over it, a literal `EXECUTE`): compiler error
  `sql.command-context-write`. The command context, the user and the role
  belong to the platform.
- In a debt unit — a statement of the `.sql` file of a `CustomTable` or a
  `PgEnum`, or of a shared `sql/` file, that is listed in `sql-debt.json`
  (a function in the closed shell, a subscription handler and a scope set
  function are never debt) — the rule is split by setting. A write to
  `simetra.*` or `session_replication_role`, `RESET ALL` and a write to
  `pg_settings` stay errors (`sql.command-context-write`, marked
  `unit: debt`). A write to the role or the request claims is a warning
  (`sql.debt-session-write`): it may stay while the unit is debt, because
  code inside a command calls only query functions, which have no such write.
  Converting the unit into a closed-shell function turns that warning into
  the error above, so remove the named statement when you convert the unit;
  write a `set_config` name as a literal, because a name built at run time
  counts as a write.
- The defaults, generated columns, checks and index expressions of an adopted
  table follow the same debt rules.

## Other paths into a command

Postgres also runs SQL implicitly in the middle of a command. Each such path
is closed by its own rule:

- **Domain `CHECK`** — follows the rules of a query function: allowlisted
  builtins as `pg_catalog.<name>`, query functions of the model
  (`sql.domain-check-not-allowed`).
- **Foreign key from a `CustomTable` to a table of a kind** — `onDelete` and
  `onUpdate` are only `restrict` or `noAction`
  (`customTable.fk-action-on-kind-table`): a cascade would write the child
  table from inside a command. Clean up the child rows in a TypeScript hook of
  the command, or promote the child table.
- **Scope root** — `onRootDelete: "cascade"` only when the root is an object
  of a kind (`scope.root-cascade-not-kind`): a `CustomTable` root is deleted by
  your SQL, and its cascade would write tables of kinds. Promote the root, or
  delete tenants through a command.
- **Extensions** — `CREATE EXTENSION … SCHEMA extensions` (a schema of the
  provider); without `SCHEMA` or with another schema it is the warning
  `sql.debt-extension-schema`. Until you fix it, code inside a command calls
  no function of the model in that schema, and none at all while an
  extension has no `SCHEMA`.

## Before a promotion

- A debt unit that writes a table being promoted is refused before any change
  (`promote.debt-writes-table`, every unit listed): rewrite the unit without
  the write, or delete it, then promote.
- A closed-shell function of the adopted table moves to the kind's module
  only when it is a query function; the others move to
  `sql/<schema>/<function>.sql`.
- An incoming foreign key with `cascade`, `setNull` or `setDefault` from a
  table that stays a `CustomTable` is set to `restrict` by the promotion
  itself (warning `promote.cascade-to-restrict`, one per key and event). The
  plan needs the permission `delete:<table>.<constraint>` for `ON DELETE` and
  `update:<table>.<constraint>` for `ON UPDATE`: after it, deleting the
  promoted row with child rows, or changing its key, is refused.
