# Users, membership and rights

Forms of the people and rights declarations; the router is `SKILL.md`.

Contents:

- Users, authorship and membership
- Rights declarations
- Rights sets and roles

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

## Rights declarations

A **carrier** is an attribute of the object, or a two-step path
`["<ref attribute>", "<attribute of its target>"]`; every step stays inside
the tenant (`rights.carrier-cross-tenant`).

- **`customActions`** — actions beyond the standard ones of the kind; each
  gets an id, `requires` names standard action words or other custom actions
  of the object, `effects` says what it writes. The name is unique among the
  object's attributes, tabular sections and custom actions.
  `{ "name": "<action>", "requires": ["update"], "effects": { "header": ["<attribute>"] } }`
  Effects only on a kind with a writing standard action (not an accumulation
  register or a recorder-subordinate information register), and
  `tabularSections: true` only on a kind with tabular sections
  (`rights.custom-action-effects`).
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
  `{ "ref": ["<ref attribute>", "<attribute>"], "dimension": "<dimension>" }`
- **`accessDimensions`** (project) — a value catalog plus where the current
  user's values come from: a relation object or a verbatim SQL function.
  `{ "name": "<dimension>", "target": <catalog ref>, "values": { "relation": { "object": <ref>, "subject": "<field>", "value": "<field>" } } }`
  or `"values": { "function": { "name": "<function>" } }`.
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
