# Users, membership and rights

Forms of the people and rights declarations; the router is `SKILL.md`.

Contents:

- Users, authorship and membership
- Rights declarations
- Rights sets and roles
- Adopted membership and assignment sources
- Who reads what
- Who writes what
- Policies and triggers on a table of a kind
- What closed code may reach
- Generated privileges
- Reading past row-level security
- Carrier copies

## Users, authorship and membership

People are platform data, not tables you write yourself:

- **Users catalog.** A Catalog with `"role": "users"` is the project's users
  catalog: at most one per project, `scope: "none"`, a description (the
  display name filled from the account). The compiler adds the standard
  `userKind` and `invalid` attributes. Every non-anonymous account of the
  identity provider gets a row through the platform's provisioning; an
  anonymous sign-in gets one when it is converted to a permanent account.
  Provisioning inserts only the key
  and the description, so the catalog's own attributes must accept that
  insert: a `required` attribute needs a `defaultValue` that passes the
  attribute's own checks, a unique attribute takes no default other than
  `{ "fill": "newUuid" }`, and its module has no row rule
  (`users.provision-unsafe` names the reason).
- **Scope root.** The users catalog may be the `root` of a scope kind
  (`{ "object": { "kind": "Catalog", "name": "<users catalog>" } }`) while
  staying `scope: "none"`; references to it from any scope kind are plain
  references, without `crossScope`. Do not point a root or a foreign key at
  the provider's account table.
- **Authorship.** `trackAuthor: true` on a Catalog or a Document adds the
  standard `createdBy` and `updatedBy` references to the users catalog;
  without a users catalog it is an error (`users.catalog-missing`).
- **Membership.** A scoped catalog with `membership: { "user": "<attribute>" }`
  is the membership of its scope kind: the attribute is a scalar `Ref` to the
  users catalog, nullable for an invited member without an account. The
  compiler derives one member per user and scope value and generates a
  "my member" function; a scope kind with `"setFunction": "membership"` gets
  its scope set function from that catalog. Use it instead of a hand-written
  member table and set function. One membership catalog per scope kind.

The platform layer (identities, the current user, provisioning) lives in the
PG schema `simetra`, generated when a users catalog exists, or when the
project has a membership source and its provider's user id is the `sub` claim
(then only the current-user function, no identities table). The schema is
reserved: no object, `defaultSchema`, set function, external reference,
event handler or SQL unit may use it, and there is no `metadata/sql/simetra/`
folder (`schema.reserved`). In SQL, the
current user is `(select simetra.current_user_id())`, written exactly so in a
policy (`sql.bare-current-user` rejects a bare call there); it is `NULL` for
an anonymous session or an anonymous sign-in of the provider, a service
session and an invalid user.

## Rights declarations

A **carrier** is an attribute of the object, or a two-step path
`["<ref attribute>", "<attribute of its target>"]`; every step stays inside
the tenant (`rights.carrier-cross-tenant`), and the first step points to an
object of a kind, not to an adopted `CustomTable`
(`rights.carrier-path-adopted`: the platform keeps a copy of the path's value
with a trigger on the target table, see "Carrier copies").

- **`customActions`** — actions beyond the standard ones of the kind; each
  gets an id, `requires` names standard action words or other custom actions
  of the object, `effects` says what it writes. The name is unique among the
  object's attributes, tabular sections and custom actions.
  `{ "name": "<action>", "requires": ["update"], "effects": { "header": ["<attribute>"] } }`
  Effects only on a kind with a writing standard action (not an accumulation
  register or a recorder-subordinate information register),
  `tabularSections: true` only on a kind with tabular sections, and never a
  transition column (`posted`, the deletion mark) or an immutable column (the
  `ref` key) in `header` (`rights.custom-action-effects`, reasons
  `transitionColumn` and `immutableColumn`).
- **`ownership`** — carriers whose `Ref` names the owner of a row (a member
  or a user). `"ownership": ["<attribute>", ["<ref attribute>", "<attribute>"]]`
  The target is the users catalog, the membership catalog of the object's own
  scope kind, or the adopted table of that scope kind's membership source
  (`rights.ownership-target`); `"ref"` (the key) owns only rows of the users
  catalog. An adopted target needs a `UNIQUE (<scope column>, <key>)`, so the
  reference becomes a composite foreign key within the scope.
- **`rightsContainer`** — the catalog is a rights container: roles can be
  assigned on its rows. `"rightsContainer": true`
- **`containerBinding`** — the carrier that binds a row to its container.
  `"containerBinding": "<attribute>"` or `["<ref attribute>", "<attribute>"]`
- **`access`** — the project access dimensions that narrow the rows, each with
  its carrier to the dimension's value catalog.
  `"access": [{ "attribute": "<attribute>", "dimension": "<dimension>" }]` or
  `{ "ref": ["<ref attribute>", "<attribute>"], "dimension": "<dimension>" }`.
  A register maps only a dimension of its own (`"attribute"`), never a
  resource, an attribute or a path (`rights.register-access-dimension`): its
  movements and totals are read by the same dimensions.
- **`accessDimensions`** (project) — a value catalog plus where the current
  user's values come from: a relation object or a verbatim SQL function.
  `{ "name": "<dimension>", "target": <catalog ref>, "values": { "relation": { "object": <ref>, "subject": "<field>", "value": "<field>" } } }`
  or `"values": { "function": { "name": "<function>" } }`.
  A read policy is named after the dimension, so a name that is `any` or
  `own`, or starts with `own_` or `in_` (in snake case), is
  `rights.dimension-name-reserved`.
  The function is verbatim SQL of a closed form: no arguments,
  `RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''`
  with an `AS $$ … $$` body,
  every name schema-qualified (also in the views it reads and the `sql`
  functions it calls; a `plpgsql` function in that chain is refused), and no
  `simetra.*` object except `simetra.current_user_id()`
  (`rights.dimension-function-*`).
- **`membershipSources`** (project) — an adopted table that holds the
  membership of a scope kind instead of a membership catalog.
  `{ "name": "<source>", "scopeKind": "<scope kind>", "table": <CustomTable ref>, "columns": { "scope": "<column>", "user": "<column>", "active": "<column>" }, "where": [<condition>] }`
  (`active` and `where` are optional). See "Adopted membership and assignment sources".
- **`assignmentSources`** (project) — an adopted table that holds role
  assignments of one level: `"global"`, `{ "scopeKind": "<scope kind>" }` or
  `{ "container": <ref> }`.
  `{ "name": "<source>", "assignedOn": "global", "table": <CustomTable ref>, "columns": { "member": "<column>", "role": "<column>" }, "where": [<condition>] }`
  (`columns` also takes `scope`, `container` and `active`). See "Adopted
  membership and assignment sources".

Dimensions and sources are project elements: add them to the project root
(`"target": { "kind": "Project" }`) and rename or delete them by
`{ "kind": "Project", "element": ["<name>"] }`; their names are unique among
all named elements of the project.

## Rights sets and roles

A **rights set** (`rights-sets/<Name>/<Name>.meta.json`) is a named group of
grants; a **role** (`roles/<Name>/<Name>.meta.json`) is what an assignment
gives a member. Both get an id from `fix` and have no physical name.

```jsonc
{
  "kind": "Role",
  "name": "<role>",
  "assignedOn": "global" | "everyUser" | { "scopeKind": "<scope kind>" } | { "container": <catalog ref> },
  "include": [{ "kind": "RightsSet", "name": "<set>" }],
  "grants": [
    { "grantAll": { "extent": "<extent>" } },
    { "grant": { "objects": [<object ref>], "actions": ["<action>"], "extent": "<extent>" } },
    { "deny": { "objects": { "withAction": "<standard action>" }, "actions": ["<action>"] } }
  ]
}
```

A set has the same `include` and `grants`, without `assignedOn` and without
`deny`. A role also takes `fullAccess`, `order`, `assignable`, `maxHolders`,
`rootCreator` and `sourceKeys` (`[{ "source": "<assignment source>", "key": "<key>" }]`,
the role's key in an adopted assignment table of the same level).

**Levels** (`assignedOn`) decide which objects a role's grants may touch:

- `"global"` — per user; in a project with scope kinds, unscoped objects only.
- `{ "scopeKind": "<scope kind>" }` — per member of a tenant: every action on
  objects of that scope kind, only `read` on unscoped ones. The scope kind
  needs a membership.
- `{ "container": <ref> }` — per row of a `rightsContainer` catalog: objects
  whose `containerBinding` leads to it.
- `"everyUser"` — every valid user without an assignment: unscoped objects,
  `own` or a dimension extent only, no `fullAccess`, no source keys.

**Grants:**

- `include` — the sets' grants become the role's; includes are transitive,
  a cycle is an error.
- `grantAll` — every action the level allows on every object of the level
  that supports the extent; an object without it is skipped.
- `grant` — the listed actions on the objects. `objects` is a list of
  references or `{ "withAction": "<standard action>" }` (every object of the
  level that has it). A custom action is granted on exactly one listed object.
- `deny` — only in a role: removes rows after the includes are expanded, with
  the given extent or, without one, every extent of the actions.

**Extents:** `"any"`, `"own"` (the object needs `ownership`) or
`{ "dimension": "<dimension>" }` (the object maps it in `access`). `any`
covers `own` and every dimension, so `X@any` also yields `X@own` and
`X@<dimension>`; `own` and dimensions do not cover each other. An action's
`requires` is met at the same extent or at `any`.

The compiler reports these as `rights.*` (for example `rights.grant-level`,
`rights.extent-unsupported`, `rights.requires-missing`,
`rights.custom-action-multi-object`, `rights.include-cycle`); the full set is
the compiler's rule catalog. Changing a role's level is an
`identity.assigned-once-changed` error; renaming its scope kind or container
is not.

## Adopted membership and assignment sources

A membership source and an assignment source make the rows of an adopted
table give rights: the platform reads them in its rights functions, the same
way as a membership catalog and the system rights catalogs. A role takes its
key in such a table through `sourceKeys`.

- **Member.** The member of a membership source is the table key, so the
  table needs a primary key of one uuid column
  (`rights.source-member-key`). The system rights catalogs of the scope kind
  refer to the member by a composite foreign key within the scope, so the
  table metadata also needs `UNIQUE (<scope column>, <key>)` in `uniques`
  (`rights.source-member-unique`). The `scope`, `user`, `member` and
  `container` columns are uuid, `active` is boolean
  (`rights.source-column-type`). A table with
  `rowLevelSecurity: forced` is refused (`rights.source-forced-rls`).
- **Without a users catalog.** The user is the `sub` claim of the session read
  as a uuid; the source's user column holds that uuid.
- **Rows.** `where` is a conjunction of conditions on columns of the table,
  `{ "column": "<column>", "equals": <string | boolean | integer> }` or
  `{ "column": "<column>", "isNull": true | false }`; rows that fail it are
  not part of the source. Use it when one table holds several kinds of rows.
  The plan does not report rows cut off by `where` as unknown role keys.
- **Scope of an assignment row** (`columns.scope`, scope level only): a column
  whose value must equal the scope of the member; `null` takes the scope from
  the member; omitted means the `scopeColumn` of the table. Omitted on a
  table without `scopeColumn` is `rights.source-scope-column`. The field on
  another level is the same error.
- **Role through a reference.** `columns.role` is either a column holding the
  role key or `{ "column": "<column>", "references": <CustomTable ref>, "key": "<column>", "where": [<condition>] }`:
  the column is a uuid reference to an adopted role table, `key` is the role
  key there, and the role `where` keeps only the roles of the source (custom
  roles with the same key do not turn a system role on). The role table needs
  a single-column uuid primary key (`rights.source-role-key`, reason
  `primaryKey`). Without a role `where` the `key` column must be unique on
  its own: a non-deferrable unique constraint or a unique index without
  predicate, operator class or collation; otherwise
  `rights.source-role-key`, reason `ambiguous`.
- **Two sources over one table** (for example global and per-scope
  assignments in one table) need `where` conditions that provably exclude
  each other on one column; add one discriminator column (for example
  `scope_type`) and give each source a different literal, or a literal
  against `isNull`. Otherwise `rights.source-where`, reason `shared`.
  `rights.source-where` also reports a condition on a column that is not
  text, uuid, boolean or integer, and an `equals` literal of the wrong type
  (`isNull` is allowed on any column).
- **Verbatim set function.** A scope kind with its own `setFunction` (SQL you
  write) must apply the same `where` and `active` conditions of its
  membership source, or the tenant boundary will differ from the platform's
  own "my scopes" function.
- **Grants.** The application role that applies the metadata owns the rights
  functions (`SECURITY DEFINER`), so it needs `USAGE` on the schema of
  every source and role table, `SELECT` on every such table, and, when a table has row level security enabled,
  must own it or have `BYPASSRLS`; `plan` refuses to write a plan otherwise
  (`plan.rights-source-access`). Rows with a role key no role declares in
  `sourceKeys` grant nothing; `plan` reports them
  (`plan.rights-source-unknown-keys`).
- **The platform only reads sources.** Whatever writes a source table
  belongs to the application; the rights safeguards (last-holder guards,
  versions, the rights journal) do not apply to those writes, which the
  compiler notes as `rights.adopted-source-writes`.
- **Deleting a member.** A member of an adopted membership referenced by
  platform role assignments cannot be deleted until those assignments are
  removed (foreign key violation `23503`).

## System rights catalogs

The system rights catalogs are Catalogs with `"role": "rightsRoles"` (custom
roles; standard tabular section `delta`) or `"role": "roleAssignments"`. Their
level is the catalog's own scope. They are read-only until rights
administration exists: a custom action on one is `rights.system-catalog-custom-action`.
Run `simetra roles` before the first `plan` on a new database.

## Who reads what

Rows are read through rights, not by default. In a project with at least one
role and a session user (a users catalog, or a membership source on a provider
whose user id is the `sub` claim):

- A table of a kind is read only through a role's `read` right on its object,
  at the extent of the grant (`any`, `own`, a dimension, in a container); its
  tabular sections and a register's movements and totals follow the object.
  `publicRead` opens every row instead and needs no right. It is an error
  (`rights.public-read-forbidden`) on the users catalog, a membership catalog
  and the rights system catalogs: for public profiles declare a separate
  catalog with the public fields and a reference to the users catalog.
- A scoped object is read only inside the reader's scopes, and only through a
  role assigned there: membership in a tenant without a role reads nothing.
- The users catalog shows only yourself and the users of members of your
  scopes (when the project has a membership catalog or a membership source),
  whatever the role grants
  on it: a scope-level `read` on the users catalog reads only those.

Without any role (or without a session user: no users catalog and no
membership source on such a provider) no right opens a row: only
`publicRead` objects are readable. `rights.scope-kind-unread` (a warning on
the scope kind in `project.meta.json`) says that no role reads any object of
that scope kind, so nobody will see their rows: grant `read` to a role or
declare one with `fullAccess`.

## Who writes what

Kind tables are written **only by commands**: the write policies grant the
command role and nobody else.

- The **root row** of a command is checked against the right of the command's
  **own action** — the standard action (`create`, `update`, `delete`, `post`,
  …) or the custom action itself, not the actions it `requires` — and only
  through that action's DML (`create` inserts, `delete` deletes, the rest
  update).
- **Every other row** is checked against the right of the **natural action of
  its DML**, a fact of the kind (`create` for an insert, `update` for an
  update, `delete` for a delete; `write` on an information register; `update`
  for both on a constant); a tabular-section row is checked against `update`
  of its owner. A DML with no natural action on that
  table is refused.
- An action without `tabularSections` does not write tabular sections. The
  transition columns (`posted`, the deletion mark) change only through `post`,
  `unpost` and `markDeletion`; `post` only sets `posted` and `unpost` only
  clears it, while `markDeletion` may set or clear the mark. A custom action is
  not a transition action and cannot name a transition column in its header
  effects (`rights.custom-action-effects`, reason `transitionColumn`).
- The ref key and the scope column of a row cannot be changed by any command,
  and a tabular-section row cannot be moved to another owner;
  a custom action that names the key in its header effects is refused
  (`rights.custom-action-effects`, reason `immutableColumn`).
- A `beforeWrite` handler that, under a transition, changes another column makes
  the command fail. Put a computation done at posting into the command hook or
  into the effects of a custom action.
- Any application SQL unit (subscription handlers wherever they live,
  object-module functions, and every statement of shared `sql/` files:
  functions, `ALTER FUNCTION`, views, domains, aggregates, policies) must not
  change the platform's session settings — `simetra.*`, the request claims
  (`request.jwt.*`) and the role (`SET ROLE`, `SET SESSION AUTHORIZATION` and
  their `RESET`) — in any form (`set_config` however it is qualified, also as
  an aggregate function, `SET`/`RESET`, a function option, a write to
  `pg_settings` or a view over it, a literal `EXECUTE`): compiler error
  `sql.command-context-write` (a debt unit is split by setting, below). The
  command context, the user and the role belong to the platform.
- In a debt unit — a statement of the `.sql` file of a `CustomTable` or a
  `PgEnum`, or of a shared `sql/` file, that is listed in `sql-debt.json`
  (a function in the closed shell, a subscription handler and a scope set
  function are never debt) — the same rule is split by setting. A write to
  `simetra.*` is an error (`sql.command-context-write`, marked `unit: debt`):
  those settings carry the command context and the rights maintenance mode,
  and `RESET ALL` and a write to `pg_settings` reset them too. A write to the
  role or the request claims (`request.jwt.*`) is a warning
  (`sql.debt-session-write`): it may stay while the unit is debt, but closed
  code must not reach the unit (next section). Converting the unit into a
  closed-shell function turns that warning into the error above, so remove
  the named statement when you convert the unit; write a `set_config` name as
  a literal, because a name built at run time counts as a write.

## Policies and triggers on a table of a kind

Only the platform attaches policies and triggers to a table of a kind (and to
its tabular sections), in any `.sql` file, shared `sql/` folder included.
A verbatim `CREATE POLICY` or `CREATE TRIGGER` there is the error
`sql.kind-table-verbatim`, and the unit can never be listed in
`sql-debt.json`. A hand-written policy would open rows past the rights, a
hand-written trigger would act inside every command. Use what replaces them:

- a policy → a right: a role's `grant` (with an extent), `ownership`,
  `access` or `publicRead` on the object;
- a trigger → an `EventSubscription` with a handler in the closed shell.

A function or procedure body does not change a table of a kind either, in
any file, closed shell and kind module included: it may only read and write
the rows (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`) and `LOCK` the
table. Any other statement on the table — a policy, trigger, grant, index,
`TRUNCATE`, `ALTER TABLE`, `COMMENT`, `DROP`, a child table, and a statement
on its whole schema (`DROP SCHEMA`, `GRANT … ON ALL TABLES IN SCHEMA`) — is
the same error with the form `functionBody`, also inside the text of a
literal `EXECUTE`, a `DO` block or a function the body creates. Such a
function is never debt. Reading the table in a nested query of another
statement (`CREATE TEMP TABLE … AS SELECT`) is fine. Remove the statement and
declare what it did: a right for row access, an `EventSubscription` for a
reaction. An unqualified table name counts in every schema, because the body
may run with any `search_path`: qualify the names of your own tables.

The same statement on a `CustomTable` is ordinary SQL debt until the table is
promoted into a kind.

## What closed code may reach

Kind module functions, subscription handlers and scope set functions run in
the middle of a command statement. Everything they reach must therefore be
SQL the compiler can check, or the policies of the following rows would run
under a changed user or role. The compiler follows the call chain, and also
the views they read, the policies of the tables they touch and the defaults
and checks of the tables they write, directly or through a view.
`sql.command-context-reach` names the
reached function, the reason and the chain. Closed code must not reach a
function that:

- executes a string built at run time (`EXECUTE` of a non-literal);
- is written in a language other than `sql` or `plpgsql`;
- the compiler does not know or whose body it cannot read;
- writes a session setting of the platform (see above).

Make the reached function `LANGUAGE sql` or `plpgsql` without `EXECUTE` of a
built string and without writes to session settings, or stop calling it.
Functions of the platform schema, generated functions, builtins and functions
of provider schemas are trusted, except those that execute SQL from a string
(`query_to_xml`, `dblink` and the like).

The shell of every function the check relies on (volatility, `SECURITY`,
`search_path`, `SET` options) is read from its `CREATE FUNCTION`. A separate
`ALTER FUNCTION` that changes it is refused
(`sql.function-settings-shell`, `RESET ALL` included): move the option into
`CREATE FUNCTION` and remove the `ALTER FUNCTION` statement.

Known limit: a debt trigger of an adopted table with `EXECUTE` of a built
string or a body in another language runs in the middle of a command when
the command reaches the table by a foreign-key cascade or by a handler's
write, and the compiler cannot close that statically. Treat such a trigger
as a candidate for conversion (a property, an `EventSubscription` or a
closed-shell function) before the first command that writes the related
table.

## Generated privileges

Privileges on what the platform owns are generated: `EXECUTE` on a declared
scope set function and on a subscription handler, and every grant on a kind's
tables. In debt SQL (a `CustomTable` or `PgEnum` module, the shared
`metadata/sql/`) a verbatim `GRANT`/`REVOKE` on them fails with
`sql.generated-grant` (a kind's own module rejects any). `simetra fix` removes
the statement (and its file, if left empty) only when every target belongs to
the platform; one that also names other objects you split by hand. A grant
on another overload of the same name is not affected.

## Reading past row-level security

`sql.definer-reads-rls` (a warning) marks a unit that reads a table under
row-level security as its owner, so the caller's policies do not apply, while
a role of the API (or `PUBLIC`) can run or read it:

- a `SECURITY DEFINER` function that someone may `EXECUTE`;
- a view without `security_invoker` that someone may `SELECT`;
- a materialized view, which stores the rows its owner read at `REFRESH`.

When the unit also reaches SQL the compiler cannot check, the diagnostic
lists the tables it found and adds that the unit reaches unchecked SQL; with
no tables found, it says only the latter. The compiler does not see the owner of a function,
so one whose owner is itself subject to row-level security is flagged too.
Convert in this order of preference:

1. Read through a right and a policy: let the caller read the kind's table
   itself, so the platform's policies decide, and make the unit
   `SECURITY INVOKER` (a view: `WITH (security_invoker = true)` in
   `CREATE VIEW`; a separate `ALTER VIEW` is not accepted in `.sql` files).
2. If the unit must run as its owner, check the caller's membership or rights
   inside it, or filter the rows with the rights functions in a view.
3. If no API caller needs it, `REVOKE EXECUTE` (function) or `REVOKE SELECT`
   (view, materialized view) from `PUBLIC` and from each API role. A
   materialized view that serves callers is replaced by a view with
   `security_invoker`.

## Carrier copies

A tabular section cannot be read by the carriers of its owner without a
copy, and neither can an object whose carrier is a path. So the platform
keeps copies: every tabular section of an object with carriers gets a column
per carrier (named like the owner's column), and a path carrier gets a column
in the object row. The copies are written only by the platform:

- A value the client writes into a copy is replaced by the value of the
  source row; a request that changes only copies is a resave.
- When the source changes, the copies of dependent rows (and of their tabular
  sections) follow. This propagation is not a change of the row: it does not
  bump `version` or `updatedAt` and fires no subscription and no platform
  `BEFORE UPDATE` guard.
- The names are taken: an attribute under a copy's name is
  `rights.carrier-column-taken`; rename the attribute.
- A `beforeWrite` handler on such a table never assigns a copy or the column
  of the first path step (`subscription.handler-assigns-carrier`: assign them
  in the command hook) and never reads a copy as `NEW.<copy>`
  (`subscription.handler-reads-carrier`: on `INSERT` it may still hold the
  client's value); look the carrier up in the row the first step points to.
- On a table with copies the row mechanics are two triggers,
  `<table>_simetra_touch` on `INSERT` and `<table>_simetra_touch_update` on an
  `UPDATE` that changes the content, and a write subscription without
  `whenChanged` gets the pair `<physicalName>` (`UPDATE`, content changed)
  and `<physicalName>_insert` (`INSERT`), so propagation triggers neither.
- A new copy on a table that already has rows is filled by a plan step of
  origin `carriers` (class `dataStep`, no `--allow` needed) that runs right
  after the engine steps, in the same transaction: each row takes the value
  from the row its composite foreign key points to, and a row without a link
  gets `NULL`. The step holds `SHARE ROW EXCLUSIVE` on the table and on its
  source until the apply ends. Triggers stay on, and a copy-only change does
  not bump `version` or fire subscriptions.
- When a copy takes the place of a column that was not a copy (a removed
  attribute that still holds data, or an adopted column the promotion
  mapping left out), the step overwrites that data: it is class
  `destructive` and needs `--allow <step id>` like any other step that loses
  data. A copy column the plan itself creates is always filled, even if the
  last applied snapshot says the copy already exists (for example, an
  administrator dropped it by hand and the drift was accepted).
