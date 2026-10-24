# Users, membership and rights

Forms of the people and rights declarations; the router is `SKILL.md`.

Contents:

- Users, authorship and membership
- Rights declarations
- Rights sets and roles
- Who reads what
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
PG schema `simetra`, generated when a users catalog exists. The schema is
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
  `{ "name": "<source>", "scopeKind": "<scope kind>", "table": <CustomTable ref>, "columns": { "scope": "<column>", "user": "<column>" } }`
- **`assignmentSources`** (project) — an adopted table that holds role
  assignments of one level: `"global"`, `{ "scopeKind": "<scope kind>" }` or
  `{ "container": <ref> }`.
  `{ "name": "<source>", "assignedOn": "global", "table": <CustomTable ref>, "columns": { "member": "<column>", "role": "<column>" } }`

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

## System rights catalogs

The system rights catalogs are Catalogs with `"role": "rightsRoles"` (custom
roles; standard tabular section `delta`) or `"role": "roleAssignments"`. Their
level is the catalog's own scope. They are read-only until rights
administration exists: a custom action on one is `rights.system-catalog-custom-action`.
Run `simetra roles` before the first `plan` on a new database.

## Who reads what

Rows are read through rights, not by default. In a project with at least one
role and a users catalog:

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
  scopes (when the project has a membership catalog), whatever the role grants
  on it: a scope-level `read` on the users catalog reads only those.

Without any role (or without a users catalog) no right opens a row: only
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
  `sql.command-context-write`. The command context, the user and the role
  belong to the platform.

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
