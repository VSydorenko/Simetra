# Users, membership and rights

Forms of the people and rights declarations; the router is `SKILL.md`.

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
