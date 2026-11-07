# Agents over MCP

Contents: launch flags; data of the development database (connect, flags,
examples, the database marker, limits).

`simetra mcp` serves the tool catalog to an agent over stdio. `simetra init`
writes its entry in the MCP client config; flags added to that entry's `args`
are kept on the next `init`.

## Launch flags

- By default the write tools change files in the served directory, under the
  same rules as the CLI: the metadata is in git, and nothing is written unless
  the result compiles. `--read-only` is a flag of `simetra mcp` only; the CLI
  has none (preview with `--dry-run`).
- With `--read-only` every tool is still listed, but a write tool is refused
  with a hint to remove `--read-only` from the server's args. Ask the owner
  before restarting the server without it.
- `apply` and `roles` write to the database only when the server runs with
  `--allow-database-write`; without it they are refused with a hint to add
  the flag. Ask the owner; never add it yourself. `--read-only` refuses
  `plan` and `apply` too: they write their files under `plans/`.
- `plan` and `apply` have no `dryRun`: review with `plan`, and check on the
  database with `rehearse`.

## Data of the development database

`data-read` and `data-command` read and change application data through the
same runtime commands as the application server, as the user named by `--as`
and with that user's rights. `--agent <uuid>` only records the agent in the
session (`act` claim); it grants nothing. Use them to seed test data, to
check what different users may see and do, and to reproduce a bug.

The owner turns them on by adding flags to the server's `args` in the MCP
client config; `simetra init` does not add them, because the user and the
variable are the owner's choice. The CLI takes the same flags per call:

```sh
pnpm exec simetra mcp --data-url-env SIMETRA_DEV_DATA_URL --as <user-uuid>
pnpm exec simetra mcp --data-url-env SIMETRA_DEV_DATA_URL --as <user-uuid> --allow-data-write
pnpm exec simetra data-read '{"query":{"object":{"kind":"Catalog","name":"Currency"},"limit":50}}' --data-url-env SIMETRA_DEV_DATA_URL --as <user-uuid>
```

- The variable holds the connection string of the runtime login role
  `simetra_runtime` (the platform gives it no password: the owner sets one on
  the development database). A login that is a superuser, bypasses RLS, or
  belongs to the migrator or the provider's service role is refused.
- Without `--data-url-env` and `--as` the data tools are refused with a hint;
  there is no default variable.
- `--allow-data-write` (MCP only): without it `data-command` is refused with a
  hint. Ask the owner; never add it yourself. The CLI writes data without it:
  the person who runs the command is the decision. `--read-only` refuses
  `data-command` and keeps `data-read`.
- `--allow-rights-write` (MCP and CLI): without it `data-command` refuses to
  write the rights catalogs (roles, role assignments) and to create a scope
  root whose creator receives a role. Membership catalogs are written without
  it, under the rights of `--as`; active membership is what makes a role
  assignment effective, so writing membership still changes who holds rights.
- An object with a module (`<Name>.module.ts` next to its `.meta.json`) is
  refused with `command.invalid`, reason `object-module`, until a later
  version: the tools do not load modules, so its hooks would not run.
  Creating a scope root whose creator receives a role (with or without
  `creatorMember`) also inserts the creator's membership row, so it needs both
  `--allow-data-write` and `--allow-rights-write`, and it is refused the same
  way when the membership catalog of that scope kind has a module.
- Every call compiles the directory and checks it against the applied model.
  After a metadata change the call gets `command.model-mismatch` until you
  `plan` and `apply` it.
- A runtime refusal comes back as `error` with a `code` (and a `reason`);
  `BigInt` values come as decimal strings and may be passed back as strings.

A query takes one of these forms:

- a card `{ object, id, tabularSections?, include? }` — the whole row;
- a page `{ object, where?, orderBy?, offset?, limit, include? }`;
- a count `{ object, where?, count: true }`;
- the lines of an owner `{ object, tabularSection, owner }`;
- a page of lines `{ object, tabularSection, where?, orderBy?, offset?, limit }`;
- a count of lines `{ object, tabularSection, where?, count: true }`.

The result is `{ rows, included?, ownerVersion? }` or `{ count, capped? }`;
a count stops at 10000 and then comes `capped`.

- `where` is a tree: `{ "and": [...] }`, `{ "or": [...] }`, `{ "not": ... }`
  and conditions `{ "attribute", "op", "value" }`. Operators: `eq`, `ne`,
  `lt`, `lte`, `gt`, `gte`, `in` (up to 200 values), `isNull` (no value),
  `contains` and `startsWith` (strings, case-insensitive). `eq` or `ne` with
  `null` is refused (reason `use-isNull`): use `isNull`.
- An attribute is a logical name, the key name or the version name. A
  polymorphic reference takes `{ "type": "<Kind>.<Name>", "id" }`.
- `orderBy` takes up to 4 attributes; the key goes only last, and without it
  the server adds the key ascending. `limit` is 1 to 200; `offset` is up to
  10000, past it page by a key condition (`{ "attribute": "<key>", "op":
  "gt", "value": <last key> }`). That condition holds only for a page sorted
  by the key alone. With `orderBy` on an attribute, the condition covers the
  whole sort tuple plus the key, from the last row of the previous page. For
  `orderBy: [{ "attribute": "code", "direction": "asc" }]`:
  `{ "or": [{ "attribute": "code", "op": "gt", "value": <last code> },
  { "and": [{ "attribute": "code", "op": "eq", "value": <last code> },
  { "attribute": "<key>", "op": "gt", "value": <last key> }] }] }`.
- A page leaves out lazy attributes (`load: "lazy"`, `Bytes` by default);
  a card returns them. Filter or sort by a lazy attribute is refused (reason
  `lazy`).
- `include` names up to 16 single-target `Ref` attributes. The rows they
  reference, as the user may see them, come in `included` under
  `"<Kind>.<Name>"` of the target; an invisible target is just missing. A
  page cannot include a lazy `Ref` (reason `lazy`).
- `tabularSections` (`true` or a list of names) puts the lines of a card
  under `tabularSections.<name>`, ordered by line number. The lines of an
  owner come with `ownerVersion`, read by the same statement; an invisible
  owner gives `{ "rows": [] }` without it. A section over 5000 lines is
  refused (reason `tabular-too-large`, `path` — the section), never cut.
- A page of lines filters by the owner (`parent`), the line number and the
  section attributes, ordered by line number by default. With a top-level
  `parent eq <id>` it also returns `ownerVersion`, and its count is not
  capped.

Read a page of rows:

```json simetra:data-read
{
  "query": {
    "object": { "kind": "Catalog", "name": "Currency" },
    "where": { "attribute": "symbol", "op": "eq", "value": "$" },
    "orderBy": [{ "attribute": "description", "direction": "asc" }],
    "limit": 50
  }
}
```

Read the lines of one owner with the owner version:

```json simetra:data-read
{
  "query": {
    "object": { "kind": "Document", "name": "Invoice" },
    "tabularSection": "lines",
    "owner": "0b9d4c5e-8f1a-4c3b-9e2d-6a7f8b9c0d1e"
  }
}
```

Read a card with the rows its references point to:

```json simetra:data-read
{
  "query": {
    "object": { "kind": "Document", "name": "Invoice" },
    "id": "0b9d4c5e-8f1a-4c3b-9e2d-6a7f8b9c0d1e",
    "include": ["customer", "currency"]
  }
}
```

Seed rows in one transaction (`id` is a new UUID you generate; `update`,
`markDeletion` and `delete` also need `expectedVersion`):

```json simetra:data-command
{
  "operations": [
    {
      "action": "create",
      "object": { "kind": "Catalog", "name": "Currency" },
      "id": "0b9d4c5e-8f1a-4c3b-9e2d-6a7f8b9c0d1e",
      "values": { "description": "US dollar", "symbol": "$" }
    }
  ]
}
```

The tools work only on a development database. Before connecting they check
that the host is this machine (`localhost`, `127.0.0.0/8`, `::1` or a unix
socket); after connecting, that the database itself carries
`simetra.environment = 'development'` (a session setting such as
`options=-c …` does not count). Only a superuser sets it. On a local Supabase
stack, once per database volume (`<project_id>` is from
`supabase/config.toml`):

```bash
docker exec -i supabase_db_<project_id> psql -U supabase_admin -d postgres -c "ALTER DATABASE postgres SET simetra.environment = 'development'"
```

Never set it on a shared or hosted database: agent access to other databases
comes in a later version.

These checks are accident guards, not a security boundary. They stop a
launch against the wrong database; they do not stop an agent: an agent with
a shell can call the CLI itself, flags included. The boundary is the
`simetra_runtime` credentials: whoever holds them can act as any user. Keep
them only in the environment of the development database.
