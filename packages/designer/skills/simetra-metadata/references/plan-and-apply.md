# The database: plan and apply

`plan` compares the live database with the metadata and writes
`plans/<from>-<to>.plan.json` next to the metadata directory (the directory
that holds `metadata/`); the database is only read. Its output shows drift
first, then each step with its class and lock level, then the `planHash`.
Show the plan to the owner before applying it.

The generated SQL grants to platform roles (`simetra_command`) that live in the
cluster, not in the database, so `plan` does not create them. Without one on
the target or the shadow server, `plan`, `diff` and `rehearse` refuse with
`plan.platform-role-missing`: run `simetra roles` once with a role that has
`CREATEROLE` ("Platform roles" in the people-and-rights reference; `postgres`
needs a superuser and no separate shadow server). It only checks an existing role; an unsafe
shape (`plan.platform-role-shape`) is fixed by hand, not by `roles`.

`apply` applies exactly that file in one transaction. It needs the `planHash`
of the reviewed plan, confirmation (`--yes`, MCP `confirm: true`), and in
`allow` the id of every step that drops data or relaxes a guarantee and
`drift` when the plan carries drift; the plan output says which items need
it. `rehearse` runs the plan and rolls it back, but still takes the same
locks as `apply`. It also builds the desired shadow database and proves on the
same connection that the catalog equals the desired state, so it holds the
plan's locks a little longer. A successful `rehearse` writes its report to
`plans/<from>-<to>.rehearsal.json` next to the plan.

Before the end of the transaction, `apply` and `rehearse` re-validate function
bodies and fire deferred constraints; an invalid constraint or index that the
desired state does not have is refused. An `apply.function-check-blind` warning lists
functions the check cannot see (another language, no `EXECUTE` for the role, a
trigger function without a trigger): nothing proved their bodies, so review
them by hand.

When the role has global default privileges, a plan also ends with environment
steps: explicit GRANT/REVOKE that cancel them on the objects the plan creates.
The output shows them as their own group, `environment rights: the global
default privileges of role <role>`; review them with the rest of the plan.
If the environment changes before the apply, it is refused
(`apply.target-changed`); plan again. A plan file from an older tool version is
refused too: rebuild it with `plan`. After a data-only restore or a
logical-replication move, reset the row version epoch (the row-version-epoch reference).

A promotion plan's `allow` also takes its listed `access:<table>`, `remove:<t>`,
`repair:<t>`, `delete:<t>.<constraint>` and `update:<t>.<constraint>` items; a
repair rewrites existing values with the fill expression shown.
A promotion is applied only with a valid rehearsal report: rehearse the plan on
a copy of the target with data first. Point the rehearsal at the copy through
the connection variable: `simetra apply --rehearse --database-url-env <VAR>`
on the command line, or an MCP server launched with
`simetra mcp --database-url-env <VAR>` (an MCP server's database is fixed at
launch). Make the copy from the target after the plan, restore it as the plan's
role with `pg_restore --no-owner`, on a server with the same PostgreSQL major
version, encoding and collation; otherwise the rehearsal is refused as not a
copy of the plan's target (`apply.target-changed`). Rehearsing on the target
itself is allowed, but it holds the target's locks for the whole run: make it
a deliberate choice of the owner, not a default. `apply` refuses without a
report (`apply.rehearsal-required`), with a stale one (`apply.rehearsal-stale`:
another plan, report format, server, ledger head, or not one row count per
promoted table), and when a table has rows on the target but none on the copy
(`apply.rehearsal-copy-empty`); it warns when the copy has fewer rows
(`apply.rehearsal-fewer-rows`) or when the statement timeout computed from the
report exceeds what Postgres accepts (`apply.rehearsal-timeout-unbounded`).

Which connection to use:

- Reads of the target (`introspect`, `diff`, `plan`) run in short read-only
  transactions and work through a transaction-mode pooler.
- The shadow database of `diff` and `plan` needs a direct or session-mode
  connection: it is created, reached by name and loaded with session settings
  that a transaction-mode pooler is not guaranteed to keep. With a pooled target
  connection, point `--shadow-url-env` at a direct one.
- A long `apply` wants a direct or session-mode connection too: a pooler may
  cut the transaction with its own timeouts.

A changed plan file, changed metadata or a changed database refuses the
apply; plan again.

If `apply` reports `outcome unknown`, the connection was lost and the apply may
or may not have been committed. Never apply again blindly: look up the printed
apply id in the `apply_id` column of `simetra.ledger` first — a row means it was
committed.
