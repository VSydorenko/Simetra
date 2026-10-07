import type pg from "pg"
import {
  readCatalog,
  type CatalogShape,
  type CatalogTable,
} from "../../../../../simetra/test/support"

/**
 * Незалежний оракул round-trip (план E2b, рішення 10): форма `pg_catalog`, яку
 * читає тестовий читач E1, плюс класи, яких він не бачить (тригери, політики,
 * ACL, `OWNED BY`, `REPLICA IDENTITY`, типові привілеї). Читач не користується
 * ні двигуном, ні моделлю каталогу: однакова втрата з обох боків extract-у
 * лишилась би видимою тут — властивість мусить бути в цілі й у тіні.
 */
export interface OracleShape {
  catalog: CatalogShape
  triggers: { table: string; name: string; definition: string }[]
  policies: {
    table: string
    name: string
    command: string
    permissive: boolean
    roles: string[]
    using: string | null
    check: string | null
  }[]
  /**
   * Діючий ACL відношень і функцій і ACL колонок (`c:`; у колонки немає
   * `acldefault`, тож рядок є лише за явного гранту), відсортований: порядок елементів — не
   * форма. `NULL` у каталозі за визначенням Postgres означає `acldefault`,
   * тож оракул порівнює саме його — інакше таблиця, створена до ADP, і та
   * сама таблиця з явним ACL власника різнилися б без різниці в правах.
   */
  acls: { object: string; acl: string[] }[]
  /** `OWNED BY` послідовностей (`pg_depend.deptype = 'a'`). */
  ownedBy: { sequence: string; column: string }[]
  /** `relreplident`, лише відмінне від типового `d`. */
  replicaIdentity: { table: string; identity: string }[]
  defaultAcls: { role: string; schema: string; type: string; acl: string[] }[]
  functions: { name: string; definition: string }[]
  /** В'юхи й матеріалізовані в'юхи: `relkind` і текст `pg_get_viewdef`. */
  views: { name: string; kind: string; definition: string }[]
}

const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

const sorted = (values: readonly string[] | null): string[] =>
  [...(values ?? [])].sort(byCodePoint)

/** Рядки за ключем, за кодовими точками: однакова база — однакова форма. */
function ordered<T>(rows: T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => byCodePoint(key(a), key(b)))
}

export async function readOracle(
  client: pg.Client,
  schemas: string[]
): Promise<OracleShape> {
  const catalog = await readCatalog(client, schemas)
  const triggers = await client.query<OracleShape["triggers"][number]>(
    `SELECT n.nspname || '.' || c.relname AS table, t.tgname AS name,
            pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = ANY($1)
`,
    [schemas]
  )
  const policies = await client.query<OracleShape["policies"][number]>(
    `SELECT n.nspname || '.' || c.relname AS table, p.polname AS name,
            p.polcmd::text AS command, p.polpermissive AS permissive,
            ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE r::regrole::text END
                    FROM unnest(p.polroles) r ORDER BY 1) AS roles,
            pg_get_expr(p.polqual, p.polrelid) AS using,
            pg_get_expr(p.polwithcheck, p.polrelid) AS check
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1)
`,
    [schemas]
  )
  const acls = await client.query<{ object: string; acl: string[] | null }>(
    `SELECT c.relkind::text || ':' || n.nspname || '.' || c.relname AS object,
            COALESCE(c.relacl, acldefault(
              (CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END)::"char", c.relowner
            ))::text[] AS acl
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
     UNION ALL
     SELECT 'f:' || n.nspname || '.' || p.proname || '('
              || pg_get_function_identity_arguments(p.oid) || ')',
            COALESCE(p.proacl, acldefault('f'::"char", p.proowner))::text[]
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.objid = p.oid AND d.deptype = 'e')
     UNION ALL
     SELECT 'T:' || n.nspname || '.' || t.typname,
            COALESCE(t.typacl, acldefault('T'::"char", t.typowner))::text[]
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ANY($1)
        AND (t.typtype IN ('e', 'd', 'r')
             OR (t.typtype = 'c' AND EXISTS (
                   SELECT 1 FROM pg_class tc
                    WHERE tc.oid = t.typrelid AND tc.relkind = 'c')))
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.objid = t.oid AND d.deptype = 'e')
     UNION ALL
     SELECT 'n:' || n.nspname,
            COALESCE(n.nspacl, acldefault('n'::"char", n.nspowner))::text[]
       FROM pg_namespace n
      WHERE n.nspname = ANY($1)
     UNION ALL
     SELECT 'c:' || n.nspname || '.' || c.relname || '.' || a.attname,
            a.attacl::text[]
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attacl IS NOT NULL
`,
    [schemas]
  )
  const ownedBy = await client.query<OracleShape["ownedBy"][number]>(
    `SELECT sn.nspname || '.' || s.relname AS sequence,
            tn.nspname || '.' || t.relname || '.' || a.attname AS column
       FROM pg_depend d
       JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
       JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_class'::regclass AND d.deptype = 'a'
        AND sn.nspname = ANY($1)
`,
    [schemas]
  )
  const replicaIdentity = await client.query<
    OracleShape["replicaIdentity"][number]
  >(
    `SELECT n.nspname || '.' || c.relname AS table,
            c.relreplident::text AS identity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
        AND c.relreplident <> 'd'
`,
    [schemas]
  )
  const defaultAcls = await client.query<{
    role: string
    schema: string
    type: string
    acl: string[] | null
  }>(
    `SELECT a.defaclrole::regrole::text AS role, n.nspname AS schema,
            a.defaclobjtype::text AS type, a.defaclacl::text[] AS acl
       FROM pg_default_acl a JOIN pg_namespace n ON n.oid = a.defaclnamespace
      WHERE n.nspname = ANY($1)
`,
    [schemas]
  )
  const functions = await client.query<OracleShape["functions"][number]>(
    `SELECT n.nspname || '.' || p.proname || '('
              || pg_get_function_identity_arguments(p.oid) || ')' AS name,
            pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.objid = p.oid AND d.deptype = 'e')
`,
    [schemas]
  )
  const views = await client.query<OracleShape["views"][number]>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind,
            pg_get_viewdef(c.oid) AS definition
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('v', 'm')
`,
    [schemas]
  )
  return {
    catalog,
    triggers: ordered(triggers.rows, (t) => `${t.table} ${t.name}`),
    policies: ordered(
      policies.rows.map((p) => ({ ...p, roles: sorted(p.roles) })),
      (p) => `${p.table} ${p.name}`
    ),
    acls: ordered(
      acls.rows.map((r) => ({ object: r.object, acl: sorted(r.acl) })),
      (r) => r.object
    ),
    ownedBy: ordered(ownedBy.rows, (r) => r.sequence),
    replicaIdentity: ordered(replicaIdentity.rows, (r) => r.table),
    defaultAcls: ordered(
      defaultAcls.rows.map((r) => ({ ...r, acl: sorted(r.acl) })),
      (r) => `${r.role} ${r.schema} ${r.type}`
    ),
    functions: ordered(functions.rows, (f) => f.name),
    views: ordered(views.rows, (v) => v.name),
  }
}

function table(shape: OracleShape, qualified: string): CatalogTable {
  const found = shape.catalog.tables.find(
    (t) => `${t.schema}.${t.name}` === qualified
  )
  if (found === undefined) throw new Error(`no table ${qualified}`)
  return found
}

/**
 * Фікстура класу: SQL цілі, керовані схеми й проєкція властивості класу з
 * оракула. Тест вимагає `expected` і в цілі, і в тіні після round-trip:
 * фікстура, що властивості не створила, чи втрата з обох боків — червоні.
 */
export interface ClassFixture {
  name: string
  schemas: string[]
  sql: string
  property: (shape: OracleShape) => unknown
  expected: unknown
}

export const CLASS_FIXTURES: ClassFixture[] = [
  {
    name: "expression and partial indexes",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.account (id uuid PRIMARY KEY, email text, closed_at timestamptz);
      CREATE INDEX account_email_lower_idx ON app.account (lower(email));
      CREATE INDEX account_open_idx ON app.account (email) WHERE closed_at IS NULL;
    `,
    property: (shape) =>
      table(shape, "app.account")
        .indexes.filter((i) => i.constraint === undefined)
        .map((i) => ({ name: i.name, keys: i.keys, where: i.where })),
    expected: [
      {
        name: "account_email_lower_idx",
        keys: [{ expression: "lower(email)" }],
        where: undefined,
      },
      {
        name: "account_open_idx",
        keys: [{ column: "email" }],
        where: "(closed_at IS NULL)",
      },
    ],
  },
  {
    name: "unique nulls not distinct",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.code (
        id uuid PRIMARY KEY,
        value text,
        CONSTRAINT code_value_key UNIQUE NULLS NOT DISTINCT (value)
      );
      CREATE UNIQUE INDEX code_lower_idx ON app.code (lower(value)) NULLS NOT DISTINCT;
    `,
    property: (shape) =>
      table(shape, "app.code").indexes.map((i) => ({
        name: i.name,
        nullsNotDistinct: i.nullsNotDistinct,
      })),
    expected: [
      { name: "code_lower_idx", nullsNotDistinct: true },
      { name: "code_pkey", nullsNotDistinct: false },
      { name: "code_value_key", nullsNotDistinct: true },
    ],
  },
  {
    name: "table without a primary key",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.event_log (at timestamptz NOT NULL DEFAULT now(), message text);
    `,
    property: (shape) => {
      const t = table(shape, "app.event_log")
      return {
        columns: t.columns.map((c) => c.name),
        constraints: t.constraints,
        indexes: t.indexes,
      }
    },
    expected: { columns: ["at", "message"], constraints: [], indexes: [] },
  },
  {
    name: "identity always",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.ticket (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        title text NOT NULL
      );
    `,
    property: (shape) => table(shape, "app.ticket").columns[0]?.identity,
    expected: { generation: "always", sequence: "ticket_id_seq" },
  },
  {
    name: "foreign key to auth.users",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.profile (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        CONSTRAINT profile_user_fk FOREIGN KEY (user_id)
          REFERENCES auth.users (id) ON DELETE CASCADE
      );
    `,
    property: (shape) =>
      table(shape, "app.profile").constraints.find(
        (c) => c.name === "profile_user_fk"
      )?.references,
    expected: {
      schema: "auth",
      table: "users",
      columns: ["id"],
      onDelete: "cascade",
      onUpdate: "noAction",
    },
  },
  {
    name: "enum type and its column",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TYPE app.order_status AS ENUM ('draft', 'posted', 'void');
      CREATE TABLE app.purchase (
        id uuid PRIMARY KEY,
        status app.order_status NOT NULL DEFAULT 'draft'
      );
    `,
    property: (shape) => ({
      enumTypes: shape.catalog.enumTypes.map((e) => [e.name, e.values]),
      column: table(shape, "app.purchase").columns[1],
    }),
    expected: {
      enumTypes: [["order_status", ["draft", "posted", "void"]]],
      column: {
        name: "status",
        type: "<schema>.order_status",
        notNull: true,
        default: "'draft'::<schema>.order_status",
      },
    },
  },
  {
    name: "trigger with its function",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.note (id uuid PRIMARY KEY, body text, updated_at timestamptz);
      CREATE FUNCTION app.note_touch() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
      CREATE TRIGGER note_touch BEFORE UPDATE ON app.note
        FOR EACH ROW EXECUTE FUNCTION app.note_touch();
    `,
    property: (shape) => ({
      triggers: shape.triggers,
      functions: shape.functions.map((f) => f.name),
    }),
    expected: {
      triggers: [
        {
          table: "app.note",
          name: "note_touch",
          definition:
            "CREATE TRIGGER note_touch BEFORE UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app.note_touch()",
        },
      ],
      functions: ["app.note_touch()"],
    },
  },
  {
    name: "row level security policy",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.diary (id uuid PRIMARY KEY, owner_id uuid NOT NULL);
      ALTER TABLE app.diary ENABLE ROW LEVEL SECURITY;
      CREATE POLICY diary_own ON app.diary FOR SELECT TO authenticated
        USING (owner_id = auth.uid());
    `,
    property: (shape) => ({
      rls: table(shape, "app.diary").rowLevelSecurity,
      policies: shape.policies,
    }),
    expected: {
      rls: "enabled",
      policies: [
        {
          table: "app.diary",
          name: "diary_own",
          command: "r",
          permissive: true,
          roles: ["authenticated"],
          using: "(owner_id = auth.uid())",
          check: null,
        },
      ],
    },
  },
  {
    name: "grant on a table",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.price (id uuid PRIMARY KEY, amount numeric);
      GRANT SELECT ON app.price TO anon;
      GRANT SELECT, UPDATE (amount) ON app.price TO authenticated;
    `,
    property: (shape) => ({
      table: shape.acls
        .find((a) => a.object === "r:app.price")
        ?.acl.filter((item) => item.startsWith("anon=")),
      // Грант на колонку живе в `pg_attribute.attacl`, а не в ACL таблиці
      column: shape.acls.find((a) => a.object === "c:app.price.amount")?.acl,
    }),
    expected: {
      table: ["anon=r/postgres"],
      column: ["authenticated=w/postgres"],
    },
  },
  {
    name: "column grant after a table revoke",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO anon;
      CREATE TABLE app.ledger (id uuid PRIMARY KEY, amount numeric);
      REVOKE ALL ON app.ledger FROM anon;
      GRANT SELECT (amount) ON app.ledger TO anon;
    `,
    property: (shape) =>
      shape.acls.find((a) => a.object === "c:app.ledger.amount")?.acl,
    expected: ["anon=r/postgres"],
  },
  {
    name: "comments",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.memo (id uuid PRIMARY KEY, body text);
      COMMENT ON TABLE app.memo IS 'Memo of a user';
      COMMENT ON COLUMN app.memo.body IS 'Free text';
    `,
    property: (shape) => {
      const t = table(shape, "app.memo")
      return [t.comment, t.columns.map((c) => c.comment)]
    },
    expected: ["Memo of a user", [undefined, "Free text"]],
  },
  {
    name: "sequence owned by a column",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.invoice (id uuid PRIMARY KEY, number bigint);
      CREATE SEQUENCE app.invoice_number_seq OWNED BY app.invoice.number;
      ALTER TABLE app.invoice ALTER COLUMN number SET DEFAULT nextval('app.invoice_number_seq');
    `,
    property: (shape) => ({
      ownedBy: shape.ownedBy,
      default: table(shape, "app.invoice").columns[1]?.default,
    }),
    expected: {
      ownedBy: [
        {
          sequence: "app.invoice_number_seq",
          column: "app.invoice.number",
        },
      ],
      default: "nextval('<schema>.invoice_number_seq'::regclass)",
    },
  },
  {
    name: "replica identity full",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.feed (id uuid PRIMARY KEY, body text);
      ALTER TABLE app.feed REPLICA IDENTITY FULL;
    `,
    property: (shape) => shape.replicaIdentity,
    expected: [{ table: "app.feed", identity: "f" }],
  },
  {
    name: "default privileges",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.item (id uuid PRIMARY KEY);
      ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;
    `,
    property: (shape) =>
      shape.defaultAcls.map((a) => ({
        role: a.role,
        type: a.type,
        anon: a.acl.filter((item) => item.startsWith("anon=")),
      })),
    expected: [{ role: "postgres", type: "r", anon: ["anon=r/postgres"] }],
  },
  {
    name: "view with a grant",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.goods (id uuid PRIMARY KEY, title text, archived boolean NOT NULL DEFAULT false);
      CREATE VIEW app.active_goods AS SELECT id, title FROM app.goods WHERE NOT archived;
      GRANT SELECT ON app.active_goods TO anon;
    `,
    property: (shape) => ({
      views: shape.views,
      anon: shape.acls
        .find((a) => a.object === "v:app.active_goods")
        ?.acl.filter((item) => item.startsWith("anon=")),
    }),
    expected: {
      views: [
        {
          name: "app.active_goods",
          kind: "v",
          definition:
            " SELECT id,\n    title\n   FROM app.goods\n  WHERE (NOT archived);",
        },
      ],
      anon: ["anon=r/postgres"],
    },
  },
  {
    name: "materialized view with a grant",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      CREATE TABLE app.sale (id uuid PRIMARY KEY, day date NOT NULL, amount numeric NOT NULL);
      CREATE MATERIALIZED VIEW app.daily_sales AS
        SELECT day, sum(amount) AS total FROM app.sale GROUP BY day;
      GRANT SELECT ON app.daily_sales TO authenticated;
    `,
    property: (shape) => ({
      views: shape.views,
      authenticated: shape.acls
        .find((a) => a.object === "m:app.daily_sales")
        ?.acl.filter((item) => item.startsWith("authenticated=")),
    }),
    expected: {
      views: [
        {
          name: "app.daily_sales",
          kind: "m",
          definition:
            " SELECT day,\n    sum(amount) AS total\n   FROM app.sale\n  GROUP BY day;",
        },
      ],
      authenticated: ["authenticated=r/postgres"],
    },
  },
  {
    name: "two tables with one name in different schemas",
    schemas: ["app", "reports"],
    sql: `
      CREATE SCHEMA app;
      CREATE SCHEMA reports;
      CREATE TABLE app.orders (id uuid PRIMARY KEY, total numeric);
      CREATE TABLE reports.orders (id uuid PRIMARY KEY, day date NOT NULL);
    `,
    property: (shape) =>
      shape.catalog.tables.map((t) => [
        t.schema,
        t.name,
        t.columns.map((c) => c.name),
      ]),
    expected: [
      ["app", "orders", ["id", "total"]],
      ["reports", "orders", ["id", "day"]],
    ],
  },
  {
    name: "PUBLIC execute revoked by a global ADP beside a schema ADP",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO anon;
      CREATE FUNCTION app.secret() RETURNS int LANGUAGE sql AS $$ select 1 $$;
    `,
    property: (shape) =>
      shape.acls
        .find((a) => a.object === "f:app.secret()")
        ?.acl.filter((item) => item.startsWith("=")),
    expected: [],
  },
  {
    name: "PUBLIC usage revoked on a type and a domain beside a schema ADP",
    schemas: ["app"],
    sql: `
      CREATE SCHEMA app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE ON TYPES TO anon;
      CREATE TYPE app.mood AS ENUM ('ok', 'bad');
      CREATE DOMAIN app.positive AS int CHECK (VALUE > 0);
      REVOKE USAGE ON TYPE app.mood FROM PUBLIC;
      REVOKE USAGE ON DOMAIN app.positive FROM PUBLIC;
    `,
    property: (shape) =>
      shape.acls
        .filter(
          (a) => a.object === "T:app.mood" || a.object === "T:app.positive"
        )
        .map((a) => a.acl.filter((item) => item.startsWith("="))),
    expected: [[], []],
  },
]
