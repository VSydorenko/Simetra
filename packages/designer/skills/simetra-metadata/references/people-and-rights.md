# Users, membership and rights

Forms of the people and rights declarations; the router is `SKILL.md`.

Contents:

- Users, authorship and membership
- Rights declarations
- Rights sets and roles
- Adopted membership and assignment sources
- Who reads what
- Who writes what
- Generated privileges
- Platform roles
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
  without a users catalog it is an error (`users.catalog-missing`). Under a
  command the platform forces `createdBy`/`updatedBy` to the current user;
  `createdBy` never changes; a `beforeWrite` handler may not assign them,
  and a subscription may not list them in `whenChanged`.
  Outside a command (an import, a migration) whoever writes the row sets
  them.
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
  transition column (`posted`, the deletion mark) or an immutable column in
  `header` (`rights.custom-action-effects`, reasons `transitionColumn` and
  `immutableColumn`). On a catalog an immutable column is any column the
  command role cannot update (the `ref` key, `createdBy`, `updatedBy`,
  `createdAt`, `updatedAt`, `version`, `predefinedName`, the platform
  attributes of the users catalog); on other kinds it is the `ref` key,
  `createdBy` and `updatedBy`.
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
  With system rights catalogs, every relation that this function or a
  verbatim scope set function reads must be a table of a kind, an adopted
  table (`CustomTable`) or a model view over them. Anything else fails with
  `rights.snapshot-source-unknown`, which names the relation and the function
  that reads it: the platform watches only those tables for the actor
  snapshot ("Rights inside a transaction" below). Read the data from such a
  table instead, or remove the read.
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
- **Commands do not write sources.** The platform puts no actor snapshot
  trigger on an adopted source, its role table or another `CustomTable` that
  the rights facts read. So application SQL must not let the command role
  (`simetra_command`) or `PUBLIC` write such a table, or the compiler fails
  with `rights.snapshot-exempt-writer`. The message names what opens the
  write; fix it as follows:
  - a write grant (also through `ALTER DEFAULT PRIVILEGES`) — remove it;
  - a view with a write grant and without `security_invoker` — remove the
    grant or create the view `WITH (security_invoker = true)`;
  - a `SECURITY DEFINER` function or procedure that writes the table — add
    `REVOKE EXECUTE ON FUNCTION <name>(<argument types>) FROM PUBLIC` after
    it, grant it to no command role, or drop `SECURITY DEFINER`; default
    privileges do not count as that revoke;
  - a `SECURITY DEFINER` trigger function that writes the table — remove its
    trigger or drop `SECURITY DEFINER`.
- **Deleting a member.** A member of an adopted membership referenced by
  platform role assignments cannot be deleted until those assignments are
  removed (foreign key violation `23503`).

## System rights catalogs

The system rights catalogs are Catalogs with `"role": "rightsRoles"` (custom
roles; standard tabular section `delta`) or `"role": "roleAssignments"`. Their
level is the catalog's own scope. A custom action on one is
`rights.system-catalog-custom-action`.
Run `simetra roles` before the first `plan` on a new database.

To administer rights, grant `read` and `administerRights` explicitly on the
system catalog at extent `any`. Neither `grantAll` nor `withAction` selects
system catalogs; a role with `fullAccess` includes their administration at
its own level. A container role cannot administer a scope's rights catalogs.
A rights administrator role must also grant `read` on the membership catalog
of its level; `administerRights` gives no implicit read, so without it an
assignment cannot address a member.
Use `administerRights` as the command's root action. It has no natural DML
counterpart, so another command cannot write a rights catalog as a side effect.

Rights changes are checked at transaction end against the actor's rights
captured before its first command change. The effective rights added by a
custom role or assignment must be covered by that snapshot. This includes
rights enabled by removing a denial or satisfying an action's requirements.
Changing an assignment's member or container checks the full new grant.
A transaction can create a role and then add its restricting denials before
the final check. A custom role that an assignment still references cannot be
deleted: marking it for deletion fails with `command.forbidden`, detail
`role-in-use`, and a physical delete fails with a foreign key violation
(`23503`). Other failures use `command.forbidden` with detail `escalation`.

Removing the last effective direct holder of a `fullAccess` archetype fails
with detail `last-full-access`. Custom roles based on that archetype do not
count as holders. Transfer the assignment within one transaction. Deleting
the scope root in that transaction removes the check when the assignment's
scope is bound to that root by a foreign key. Concurrent changes may need a
transaction retry after a serialization failure or deadlock.

An occupied membership row cannot be reassigned to another user. Only the
invited user can fill an empty user reference, and only if that user does not
already belong to the scope.
A row cannot be re-inserted under an id that a rights assignment still
references; for a user, a membership row also blocks it. Other application
references do not block re-insertion. Commands do not change the users
catalog's `invalid` or `userKind`; provider provisioning and invalidation
remain platform operations.

Direct writes without command context fail with detail `rights-context`.
Platform tools use a maintenance mode that bypasses only the actor's grant
subset check, preserving the in-use-role and last-holder checks. Application
SQL must not enable it, and neither provider service logins nor the
platform's runtime login `simetra_runtime` can enable it.
`TRUNCATE` is refused for guarded rights, membership, user and dimension
relation tables, including in maintenance mode.

For a rights cache key, combine `simetra.rights_projection_version()` with
`simetra.rights_versions()`: the former identifies the compiled rights rules,
the latter tracks changes in the caller's scopes. Writes to adopted tables
do not bump the rights version, because the platform puts no triggers on
them: this covers adopted membership and assignment sources and a dimension
relation that is an adopted `CustomTable`. The platform rights journal
records changes to system rights catalogs in the same transaction, including
the actor (null for maintenance), reason, and before/after images.

When applying metadata changes, inspect the plan's `plan.rights-orphans`
warnings about orphaned role, assignment and delta references; those rows
grant no matching rights. Clean them with commands ("Rights administration
commands" below). The plan refuses a code change that would remove
the last effective `fullAccess` holder with `plan.rights-full-access-lost`. Restore the holder or transfer administration before
applying that change.

## Rights administration commands

Administer rights with the ordinary operations of the system rights
catalogs through `runtime.run` (`simetra/server`). Every operation on them
runs under `administerRights`:

- custom role: `create`, `update` with `expectedVersion` (the `delta`
  tabular section is replaced whole), `markDeletion` on the roles catalog;
- assignment: `create`, and `delete` with `expectedVersion`, on the role
  assignments catalog.

The runtime adds no rights checks of its own. The database judges the
transaction at `COMMIT`, and the runtime maps its refusals:
`command.forbidden` with `escalation`, `role-in-use` or `last-full-access`,
and `command.conflict` for a stale version. Assigning a role to yourself
fails at `COMMIT` with `escalation`.

**Rights inside a transaction.** A command uses the rights its actor had
when its transaction started. Before the first change of a table that feeds
the actor's rights (role assignments, custom roles, membership, users,
dimension relations, tables read by verbatim dimension and scope set
functions), the database takes a snapshot of those rights. The command core,
row level security and the rights functions then read the snapshot until the
transaction ends. So a right granted inside a command's transaction takes
effect from the next transaction: a phase or hook that uses a role the batch
has just assigned to its own actor fails with `command.forbidden`, reason
`no-right`, and a read returns no rows. This also holds for host code that
writes with the runtime login directly. Phases and hooks may run in any
order: a membership `onWrite` that assigns a role with `ctx.run` does not
limit the next phases of the batch. A read only transaction does not take a
snapshot.

**Transfer `fullAccess`** in one batch: assign the archetype to the new
holder and delete your own assignment, in either order. The last-holder check
runs at `COMMIT`, and the command core reads your rights at the start of the
transaction.

**Clean orphans.** `simetra plan --format json` returns `rightsOrphans` with
`roles`, `assignments` and `deltas`, also when the status is `unchanged`.
Each entry has the catalog `object`, the row `id`, the expected `version`
and, on a scope level, the `scope`. A delta row and an assignment of an
orphan role also have the `role` id; the version of a delta row is its
role's version. The list is complete; the warning text shows only the first
rows. Send one batch in this order:

1. `delete` every entry of `assignments`;
2. `markDeletion` every entry of `roles`;
3. `update` every role named in `deltas`, with its delta without those rows.

`update` replaces the whole delta, so send the rows that stay. The runtime
does not read tabular sections yet: read them with your own query. A stale
version fails with `command.conflict`; run `plan` again and rebuild the
batch.

## Tenant creation

A tenant is a row of a scope root: the catalog its scope kind is rooted on.
The scope kind, not the creator's role, picks the model:

- **Creator model**: the scope kind has a scope role with `rootCreator: true`.
  The `create` of the root also inserts the creator's member row and assigns
  the creator that role, in the same transaction. The creator holds the role
  in exactly the new scope already inside this transaction; `COMMIT` judges
  everything else as usual.
- **Operator model**: no `rootCreator` role. The root is created without a
  member, and the first owner comes from `tenantFullAccess` of the rights
  maintenance tool.

**The right to create a root** comes only from an explicit `create` grant on
the root in a `global` or `everyUser` role. `grantAll`, `withAction` and
`fullAccess` do not give it, and a scope or container role cannot grant it
(`rights.grant-level`). Self-service is `everyUser` with `create@own`: the
root needs `trackAuthor` and `"createdBy"` in its `ownership`
(`rights.root-create-author`), because the new row has no other owner. An
operator is a `global` role with `create@any`. Creating a root needs no
`read` on it. A global `fullAccess` holder can still assign a global role
that grants it.

**A scope kind with `rootCreator`** needs (each is a compiler error):

- a membership catalog with `membership`, not an adopted membership source
  (`rights.root-creator-membership`);
- `setFunction: "membership"` (`rights.root-creator-set-function`);
- the system role assignments catalog of its level
  (`rights.root-creator-assignments`), and no required attribute without a
  `defaultValue` on that catalog (`rights.root-creator-assignment-required`):
  the creator's assignment is inserted with the key, scope, member and role
  only;
- `rootCreator` on a scope role (`rights.root-creator-level`), on one role of
  the scope kind (`rights.root-creator-duplicate`);
- no SQL subscription (`beforeWrite`, `onWrite`) that fires on `INSERT` of
  its membership catalog or role assignments catalog
  (`rights.root-creator-subscription`): the platform writes the creator's
  rows as the table owner. Put that logic in a command hook of the catalog.

A `rootCreator` role without `fullAccess` and without `administerRights` on
the rights catalogs of its level gets the warning
`rights.root-creator-no-admin`: the creator could not assign roles in the new
tenant. A `rootCreator` role on a scope kind whose root no command creates
(the root is `Users`: provisioning creates its rows) gets the warning
`rights.root-creator-unreachable`: no tenant creation assigns the role, so
assign the first role with the operator tool.

**The operation** goes through `runtime.run` like any other:

```jsonc
{
  "action": "create",
  "object": { "kind": "Catalog", "name": "<root>" },
  "values": { … },
  "creatorMember": { … }
}
```

- Do not pass `id`: the runtime generates the root id (and the member row id)
  once per `runtime.run`, and a retry reuses them. A `ctx.run` from a hook
  generates new ids on each attempt, because the hook runs again. `id` or `tabularSections` on a root
  `create` fails with `command.invalid`; fill tabular sections with a later
  `update`.
- `creatorMember` holds attributes of the creator's member row that a command
  may insert; the platform sets the key, the scope and the user. It defaults
  to `{}`. It is allowed only on the root of a kind with `rootCreator`. A
  missing required attribute, or a reference to a row that is missing or that
  the creator cannot read, fails with `command.invalid` and the path
  `creatorMember.<attribute>`.
- Hooks run in this order: `beforeWrite` of the root, `beforeWrite` of the
  membership catalog (draft `{ values: creatorMember }`, `ctx.id` is the
  member row id, `ctx.isNew`), `onWrite` of the root, `onWrite` of the
  membership catalog. A membership `onWrite` may assign more roles with
  `ctx.run`; `COMMIT` judges them as ordinary commands.
- `rows[0]` of the result is the root row. In the operator model the creator
  cannot read the new root, so the row has only its key and version (`1`).
  The member row goes only to the membership `onWrite`. If the
  `rootCreator` role cannot read the membership catalog, that row also has
  only its key and version (`1`).

The rights journal records the creator's assignment with the reason
`root-creator`. A later change of that assignment is an ordinary command.

## Rights maintenance tool

`simetra rights-maintenance '<json>' [dir] --yes` writes one assignment
outside commands, in the database maintenance mode. It is a command line
tool only, not an MCP tool, and without `--yes` it does not connect. Connect
as the migrator that applied the plan (`SIMETRA_DATABASE_URL`): maintenance
mode works only for the login that owns the rights functions. The input has
one action:

- `{ "action": "firstGlobalAssignment", "user": "<uuid>", "role": "<role>" }`
  — the first global assignment of a new database. Once any global
  assignment exists, it fails with `maintenance.not-first`.
- `{ "action": "restoreGlobalFullAccess", "user": "<uuid>", "role": "<role>" }`
  — a global `fullAccess` holder when no effective one is left. Omit `role`
  when the project has exactly one assignable global `fullAccess` role.
- `{ "action": "tenantFullAccess", "scopeKind": "<scope kind>", "scope": "<uuid>", "user": "<uuid>", "role": "<role>", "member": { … } }`
  — the `fullAccess` owner of one scope without an effective holder. Use it
  for the first owner when an operator creates tenants (no `rootCreator`
  role), and for a tenant whose only holder became invalid. If the user is
  already a member, the member gets the role; do not pass `member` then.
  Otherwise the tool inserts a member row with the `member` values,
  attributes of your membership catalog that a command may insert. The tool
  sets the key, the scope and the user itself, and checks the references in
  `member` like a command does: the target must exist in the same scope.

The role must be `assignable`. For `tenantFullAccess` it is a `fullAccess`
role of exactly that scope kind. The tool refuses without writing and exits
with a non-zero code when:

- another `apply` or maintenance run holds the lock (`maintenance.busy`);
- the applied model is not the compiled one (`maintenance.model-mismatch`):
  run `plan` and `apply` first;
- the user, the scope or the role is unknown, or the role does not fit the
  action;
- the level already has an effective holder (`maintenance.holder-exists`);
- the user would not be an effective holder (`maintenance.not-effective`);
- a required member attribute has no value (`maintenance.member-required`);
- a reference in `member` (also an array `Ref` or a polymorphic pair) points
  to a missing row or a row of another scope (`maintenance.invalid-member`,
  with the `path` of the attribute).

`maintenance.refused` means that the database refused the write. Most often
the login is not the migrator. `maintenance.outcome-unknown` means that the
connection dropped after the write; run the tool again to see the state. The
rights journal records the write with no actor and the reason
`maintenance`. The tool is verified against the local Supabase stack,
directly and through its pooler; the hosted pooler is not verified yet.

## Rights analysis

The database answers rights questions with the same rights functions the
policies use. `simetra.rights_mine()` returns the caller's own rights; any
user may call it. The other analysis functions disclose someone else's
rights, so they return rows only when the caller holds `administerRights` on
the role assignments catalog of the requested level (scope kind and scope,
or the global level with a zero uuid for both). Without that right they
return nothing, never an error:

- `simetra.rights_member(scope_kind, scope, member)` — the rights of a member
  of that scope, with their origin (`via` is `archetype` or `delta`). The
  member must belong to the scope; the global form takes a user id.
- `simetra.rights_who(action, object, scope_kind, scope)` — members of that
  scope whose roles grant the action on the object. It answers per scope or
  for the global level; it does not merge tenants.
- `simetra.rights_explain(object, row, user)` — one row per read policy of
  the object with `has_right` and `carrier_match`. A row is visible to the
  user when every `restrictive` row matches and at least one `permissive` row
  has both flags. It explains only rows the caller can read, and only for a
  user who belongs to the row's scope; an unknown row returns nothing. A
  `publicRead` row is the exception: any user gets its single public-read
  row, matching what row-level security shows.
  `carrier_match` is null when the carrier set comes from a verbatim
  function of yours and the user is not the caller. Register and constant
  rows are not explained.
- `simetra.rights_journal_of(scope_kind, scope, limit)` — the rights journal
  of that scope, newest first, at most 1000 rows.

The service role cannot execute these functions. They read claims, so they
return nothing in maintenance mode or without a session user. Build a client
rights snapshot from these functions and cache it by the rights cache key
above.

## Supported limits

Measured on one developer machine (PostgreSQL 17.6, local Supabase stack;
reads and rights commands 2026-11-05, carrier rows 2026-10-31); treat them as
orders of magnitude, not guarantees.

| Scenario | Volume | Time |
| --- | --- | --- |
| Read a scoped table, dimension values per user | 20,000 values, 120,000 rows | list 0.57 s, point 18 ms |
| Read a scoped table, `fullAccess` holder in N scopes | 100 / 500 / 2,000 scopes, 100,000 rows | list 0.05 / 0.2 / 1.2 s |
| Owner carrier change, tabular section fan-out | 100,000 / 300,000 section rows | 2.5 / 8.0 s |
| Carrier backfill plan step | 1,000,000 section rows | 36 s |
| One rights command (assignment) in its own transaction | 11,000 assignments | 28 ms |
| Rights commands in one transaction | 1,000 commands | 7.1 s |
| Create a tenant with its creator, actor in N scopes | 1 / 2,000 scopes | core 29 / 237 ms, `COMMIT` 30 ms / 5.8 s |

- A `fullAccess` holder costs about 0.6 ms per scope on a list read: up to
  about 1,500 scopes a read stays under a second. The scope count is data, so
  no compiler warning covers it.
- Split batch rights changes into transactions: one command takes about
  30 ms, while a thousand commands in one transaction take about 7 s.

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
- The ref key of a catalog, document or tabular-section row never changes —
  not in a command, not in application SQL, not in maintenance mode, and also
  in a project without rights (`42501` `command.forbidden`, detail `effect`,
  the key column). The scope column of a row cannot be changed by any command,
  and a tabular-section row cannot be moved to another owner;
  a custom action that names the key in its header effects is refused
  (`rights.custom-action-effects`, reason `immutableColumn`).
- A `beforeWrite` handler that, under a transition, changes another column makes
  the command fail. Put a computation done at posting into the command hook or
  into the effects of a custom action.
- Application SQL never writes a table of a kind and never changes the
  platform's session settings: `SKILL.md`, section "The SQL module: closed
  forms only", names the reference with those rules.

## Generated privileges

Privileges on what the platform owns are generated: `EXECUTE` on a declared
scope set function and on a subscription handler, and every grant on a kind's
tables. In debt SQL (a `CustomTable` or `PgEnum` module, the shared
`metadata/sql/`) a verbatim `GRANT`/`REVOKE` on them fails with
`sql.generated-grant` (a kind's own module rejects any). `simetra fix` removes
the statement (and its file, if left empty) only when every target belongs to
the platform; one that also names other objects you split by hand. A grant
on another overload of the same name is not affected.

## Platform roles

`simetra roles` creates the cluster roles the platform needs. It creates
`simetra_command` (`NOLOGIN NOINHERIT`, on the target and the shadow server)
and, when a project file is present, the runtime login role `simetra_runtime`
on the target only (`LOGIN NOINHERIT`, a member of `simetra_command` and, for
`supabase`, of `authenticated`, each `WITH INHERIT FALSE, SET TRUE`). It reads
`database.provider` from the project file; without a project file it skips the
login role, and the output says why. The operator sets the login role's
password; the platform keeps no secrets.

The login role needs `ADMIN OPTION` on each of its parent roles in the role
that runs `roles`. Without it `roles` still creates the grant roles, but
refuses the login role with `roles.admin-option-missing` and does not create
it. An existing role is only checked, never changed.

`plan.platform-role-shape` with the violation `request-role:<role>` means an
API request role (such as `authenticated`) and a platform role are members of
each other in some form, even `ADMIN` alone; revoke that membership.

## Reading past row-level security

`sql.definer-reads-rls` (a warning) marks a unit that reads a table under
row-level security as its owner, so the caller's policies do not apply, while
a role of the API (or `PUBLIC`) can run or read it:

- a `SECURITY DEFINER` function that someone may `EXECUTE`;
- a view without `security_invoker` that someone may `SELECT`;
- a materialized view, which stores the rows its owner read at `REFRESH`.

The diagnostic lists the tables it found. The compiler does not see the owner of a function,
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
