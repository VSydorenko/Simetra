# Schema introspection та DDL generation для візуального конфігуратора бізнес-метаданих

**Побудова модуля schema introspection і DDL generation для .NET/PostgreSQL/React-стеку цілком реалістична** — усі чотири досліджені інструменти (pg_meta, Drizzle Kit, Prisma, EF Core) демонструють різні, але ефективні підходи до читання схеми, порівняння станів та генерації DDL. Найціннішим для .NET-реалізації є: SQL-запити інтроспекції з pg_meta (переносяться без змін), snapshot-based diff з Drizzle Kit, trait-based архітектура Prisma, та програмний ModelBuilder API з EF Core. Цей документ містить детальний аналіз кожного інструменту з прикладами коду та конкретними рекомендаціями.

---

## A. Supabase pg_meta — RESTful обгортка над pg_catalog

### Архітектура та організація коду

**pg_meta** — це TypeScript-сервіс на базі Fastify, що нормалізує системні каталоги PostgreSQL у зручний REST API. Ліцензія Apache 2.0, ~1200 зірок на GitHub. Архітектура побудована на чіткому розділенні відповідальностей:

```
src/
├── lib/
│   ├── index.ts                    — Головний клас PostgresMeta
│   ├── types.ts                    — TypeBox-схеми для всіх PG-об'єктів
│   ├── PostgresMetaTables.ts       — CRUD для таблиць
│   ├── PostgresMetaColumns.ts      — CRUD для колонок
│   ├── PostgresMetaFunctions.ts    — CRUD для функцій
│   ├── PostgresMetaPolicies.ts     — CRUD для RLS-політик
│   ├── PostgresMetaTriggers.ts     — CRUD для тригерів
│   └── sql/
│       ├── tables.sql              — SQL-запит інтроспекції таблиць
│       ├── columns.sql             — SQL-запит інтроспекції колонок
│       ├── functions.sql           — SQL-запит інтроспекції функцій
│       └── ...                     — Інші SQL-файли
├── server/
│   ├── server.ts                   — Fastify entry point
│   └── routes/                     — REST-обробники
```

Кожен сервісний клас (PostgresMetaTables, PostgresMetaColumns тощо) реалізує стандартний набір методів: `list()`, `retrieve()`, `create()`, `update()`, `remove()`. Результат завжди обгорнутий у `PostgresMetaResult<T> = { data: T | null, error: Error | null }`.

### Інтроспекція через pg_catalog

pg_meta використовує **виключно pg_catalog** (не information_schema), що дає глибший доступ до PostgreSQL-специфічних метаданих. Ключові системні таблиці та функції:

| Ціль | Каталог/функція | Що отримують |
|------|-----------------|-------------|
| Таблиці | `pg_class` (relkind='r','p'), `pg_namespace`, `pg_stat_user_tables` | Ім'я, схема, RLS, розмір, оцінка рядків |
| Колонки | `pg_attribute`, `pg_type`, `pg_attrdef` | Ім'я, тип, default, nullability, identity |
| Обмеження | `pg_constraint` | PK, FK, UNIQUE, CHECK |
| Індекси | `pg_index`, `pg_class`, `pg_am` | Визначення, метод, унікальність |
| Функції | `pg_proc`, `pg_language`, `pg_type` | Визначення, мова, volatility |
| Тригери | `pg_trigger`, `pg_proc` | Ім'я, функція, timing |
| RLS-політики | `pg_policy` | Команда, ролі, USING/WITH CHECK |
| Коментарі | `pg_description` | Описи об'єктів |

**Приклад запиту інтроспекції функцій** (з `src/lib/sql/functions.sql`):

```sql
SELECT
  p.oid AS id,
  n.nspname AS schema,
  p.proname AS name,
  l.lanname AS language,
  CASE WHEN l.lanname = 'internal' THEN p.prosrc
       ELSE pg_get_functiondef(p.oid)
  END AS definition,
  pg_get_function_arguments(p.oid) AS argument_types,
  t.typname AS return_type,
  CASE
    WHEN p.provolatile = 'i' THEN 'IMMUTABLE'
    WHEN p.provolatile = 's' THEN 'STABLE'
    WHEN p.provolatile = 'v' THEN 'VOLATILE'
  END AS behavior,
  p.prosecdef AS security_definer
FROM pg_proc p
  LEFT JOIN pg_namespace n ON p.pronamespace = n.oid
  LEFT JOIN pg_language l ON p.prolang = l.oid
  LEFT JOIN pg_type t ON t.oid = p.prorettype
```

Ключові PostgreSQL-функції для інтроспекції: **`format_type(atttypid, atttypmod)`** для людиночитабельних типів, **`pg_get_expr(adbin, adrelid)`** для default-виразів, **`pg_get_constraintdef(oid)`** для визначень обмежень, **`pg_get_indexdef(oid)`** для визначень індексів.

### DDL generation через шаблони

DDL генерується через JavaScript template literals з безпечним екрануванням через `pg-format`:

```typescript
// Створення функції (з PostgresMetaFunctions.ts)
const sql = `
  CREATE FUNCTION ${ident(schema)}.${ident(name)}(${args.join(', ')})
  RETURNS ${rettype}
  AS ${literal(definition)}
  LANGUAGE ${language}
  ${behavior}
  ${security_definer ? 'SECURITY DEFINER' : 'SECURITY INVOKER'}
`;

// ALTER TABLE для колонок
const sql = `ALTER TABLE ${ident(schema)}.${ident(table)}
  ADD COLUMN ${ident(name)} ${type}
  ${is_nullable === false ? 'NOT NULL' : ''}
  ${default_value ? `DEFAULT ${default_value}` : ''}`;
```

Патерн **«Execute-then-Refetch»**: після виконання DDL об'єкт перечитується через інтроспекційний SQL для повернення повного представлення.

### Внутрішня модель даних (TypeBox → C# records)

pg_meta використовує `@sinclair/typebox` для одночасної runtime-валідації та TypeScript-типізації:

```typescript
// TypeScript (TypeBox)                    // Еквівалент C#
const postgresColumnSchema = Type.Object({ // public record PostgresColumn(
  table_id: Type.Number(),                 //   long TableId,
  schema: Type.String(),                   //   string Schema,
  table: Type.String(),                    //   string Table,
  name: Type.String(),                     //   string Name,
  default_value: Type.Union([              //   string? DefaultValue,
    Type.String(), Type.Null()]),
  data_type: Type.String(),               //   string DataType,
  format: Type.String(),                   //   string Format,
  is_identity: Type.Boolean(),             //   bool IsIdentity,
  is_nullable: Type.Boolean(),             //   bool IsNullable,
  is_unique: Type.Boolean(),               //   bool IsUnique,
  enums: Type.Array(Type.String()),        //   List<string> Enums,
  comment: Type.Union([                    //   string? Comment
    Type.String(), Type.Null()])
});                                        // );
```

### Що переносити на .NET

**SQL-запити інтроспекції — головна цінність** pg_meta для нашого проєкту. Вони переносяться 1:1, працюючи з будь-яким PostgreSQL-клієнтом (Npgsql). Для безпечного екранування ідентифікаторів в C# використовується `NpgsqlConnection.EscapeIdentifier()` (аналог `pg-format.ident()`). TypeBox-схеми природно мапляться на C# `record`-типи, а сервісний патерн — на ASP.NET Core Minimal APIs з Dependency Injection.

---

## B. Drizzle Kit — snapshot-based diff із інтерактивним розв'язанням rename

### Чотирифазний pipeline міграцій

Drizzle Kit трансформує TypeScript-схему в SQL через чіткий pipeline:

```
TypeScript Schema → JSON Snapshot → Squash + Diff → JsonStatement[] → SQL
```

Ключові файли в репозиторії `drizzle-kit/src/`:

| Файл | Рядків | Призначення |
|------|--------|------------|
| `serializer/pgSchema.ts` | ~886 | Zod-схеми snapshot, PgSquasher |
| `serializer/pgSerializer.ts` | ~2100 | Серіалізація TS → JSON |
| `snapshotsDiffer.ts` | ~1060 | Багатофазний diff engine |
| `jsonStatements.ts` | ~500 | IR для DDL-операцій |
| `sqlgenerator.ts` | ~3100 | Convertor-класи → SQL |

### Формат snapshot (JSON, версія 7)

Snapshot — Zod-валідований JSON, що описує повний стан схеми:

```json
{
  "version": "7",
  "dialect": "postgresql",
  "id": "abc123-uuid",
  "prevId": "prev-uuid",
  "tables": {
    "public.users": {
      "name": "users",
      "schema": "public",
      "columns": {
        "id": { "name": "id", "type": "serial", "primaryKey": true, "notNull": true },
        "email": { "name": "email", "type": "text", "notNull": false, "isUnique": true }
      },
      "indexes": {},
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "checkConstraints": {},
      "policies": {},
      "isRLSEnabled": false
    }
  },
  "enums": {},
  "schemas": {},
  "sequences": {},
  "roles": {},
  "views": {},
  "_meta": {
    "schemas": {},
    "tables": {},
    "columns": {}
  }
}
```

Файлова структура міграцій: `drizzle/meta/_journal.json` (журнал), `drizzle/meta/NNNN_snapshot.json` (знімки), `drizzle/NNNN_name/migration.sql` (SQL-файли). Маркер `-->statement-breakpoint` розділяє окремі DDL-інструкції.

### Алгоритм schema diff

**Фаза 1 — Squashing.** Перед порівнянням вкладені об'єкти (індекси, FK, constraints) "стискаються" в плоскі рядки-роздільники для ефективного json-diff:

```typescript
// PgSquasher.squashFK() приклад
"fk_name;tableFrom;col1,col2;tableTo;refCol1,refCol2;CASCADE;NO ACTION"
```

**Фаза 2 — JSON Diff.** Бібліотека `json-diff` порівнює squashed-версії двох snapshot і виявляє added/deleted/modified елементи.

**Фаза 3 — Dependency-ordered Multi-Phase Diff.** Функція `applyPgSnapshotsDiff()` обробляє зміни в строгому порядку залежностей: **schemas → enums → sequences → tables → columns → roles → policies → views → indexes/FKs**. Після кожної фази rename-маппінги застосовуються до робочого snapshot, щоб залежні об'єкти коректно зіставлялися.

**Фаза 4 — JsonStatement[] IR.** Diff-engine генерує масив типізованих проміжних операцій (~30+ типів): `create_table`, `rename_table`, `alter_table_alter_column_set_type`, `create_index`, `create_foreign_key` тощо.

### Розв'язання rename vs drop+create

**Drizzle Kit не використовує евристики** — замість цього застосовує **інтерактивні резолвери**. Коли diff-engine знаходить одночасно видалений і доданий об'єкт, він не може визначити: це rename чи delete+create. Тому CLI запитує користувача:

```
Is table "users" renamed to "accounts"? [y/N]
Is column "name" in table "users" renamed to "fullName"? [y/N]
```

Резолвери ін'єктуються як callback-функції в `applyPgSnapshotsDiff()` — це чистий dependency injection:

```typescript
type Resolver = (input: {
  created: { name: string }[];
  deleted: { name: string }[];
}) => Promise<{
  created: { name: string }[];
  deleted: { name: string }[];
  renamed: { from: { name: string }; to: { name: string } }[];
}>;
```

Цей патерн дозволяє одному diff-engine працювати для CLI (інтерактивні промпти), push (автоматичні резолвери), програмного API (кастомна логіка) та тестів (mock-резолвери).

### SQL generation через Convertor pattern

SQL генерується через поліморфну систему Convertor-класів:

```typescript
abstract class Convertor {
  abstract can(statement: JsonStatement, dialect: Dialect): boolean;
  abstract convert(statement: JsonStatement): string | string[];
}

// Реєстр конверторів (~50 класів)
const convertors: Convertor[] = [
  new PgCreateTableConvertor(),
  new PgAlterTableRenameConvertor(),
  new PgAlterColumnSetTypeConvertor(),
  new PgCreateIndexConvertor(),
  new PgCreateForeignKeyConvertor(),
  new PgCreateEnumConvertor(),
  new PgCreatePolicyConvertor(),
  // ...
];

// Роутер: для кожного JsonStatement знаходить відповідний Convertor
function fromJson(statements: JsonStatement[], dialect: Dialect): string[] {
  return statements.flatMap(stmt => {
    const conv = convertors.find(c => c.can(stmt, dialect));
    return conv.convert(stmt);
  });
}
```

**Приклад згенерованого SQL:**
```sql
CREATE TABLE "posts" (
  "id" SERIAL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "user_id" INTEGER REFERENCES "users"("id") ON DELETE CASCADE
);
-->statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" TEXT;
```

### Що запозичити для нашого генератора

- **Snapshot-based diff** — порівняння нормалізованих JSON-знімків замість AST
- **Squashing** — стискання вкладених об'єктів для ефективного порівняння
- **Resolver injection** — DI для розв'язання rename-неоднозначностей
- **JsonStatement[] IR** — типізований проміжний формат між diff і SQL
- **Convertor registry** — розширюваний патерн для SQL-генерації
- **Versioned snapshots** — кожна міграція зберігає повний знімок для порівняння

---

## C. Prisma Migrate — Rust-engine з shadow database

### Pipeline трансформації schema → SQL

Prisma реалізує повний pipeline від декларативної `.prisma`-схеми до SQL DDL:

```
.prisma → PSL Parser → ValidatedSchema (AST)
                              ↓
                  sql_schema_calculator
                              ↓
                       SqlSchema (IR)
                              ↓
               sql_schema_differ(from, to)
                              ↓
                    SqlMigration (кроки)
                              ↓
                sql_renderer (per-dialect)
                              ↓
                      migration.sql
```

**SqlSchema** — центральне проміжне представлення (database-agnostic):

```rust
pub struct SqlSchema {
    pub tables: Vec<Table>,
    pub enums: Vec<Enum>,
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub foreign_keys: Vec<ForeignKey>,
    // views, procedures, namespaces...
}
```

SqlSchema заповнюється з двох джерел: з `.prisma`-файлу (через `sql_schema_calculator`) або з живої бази (через `sql-schema-describer` — інтроспекція).

### Архітектура schema diff engine

Prisma-engines — monorepo на Rust з модульною trait-based архітектурою. Ключові crates:

| Crate | Роль |
|-------|------|
| `psl` | Парсер/валідатор Prisma Schema Language |
| `schema-core` | JSON-RPC оркестрація (diff, createMigration, schemaPush) |
| `schema-connector` | Абстрактні трейти SchemaConnector, DestructiveChangeChecker |
| `sql-schema-connector` | SQL-реалізація: differ, renderer, destructive checker |
| `sql-schema-describer` | Інтроспекція живої БД → SqlSchema |

Центральний трейт **SchemaConnector**:

```rust
pub trait SchemaConnector: Send + Sync {
    fn diff(&self, from: SqlSchema, to: SqlSchema) -> Migration;
    fn render_script(&self, migration: &Migration, diagnostics: &DestructiveChangeDiagnostics) -> String;
    fn schema_from_datamodel(&self, schema: &ValidatedSchema) -> SqlSchema;
    fn introspect(&mut self, ...) -> ConnectorResult<IntrospectResult>;
    fn apply_migration(&mut self, migration: &Migration) -> BoxFuture<'_, ConnectorResult<u32>>;
    fn destructive_change_checker(&mut self) -> &mut dyn DestructiveChangeChecker;
    fn migration_persistence(&mut self) -> &mut dyn MigrationPersistence;
}
```

SQL-рендеринг має **per-dialect реалізації**: `postgres_renderer.rs`, `mysql_renderer.rs`, `sqlite_renderer.rs`, `mssql_renderer.rs`.

### Обробка destructive changes — двофазна перевірка

Prisma реалізує **двофазну перевірку руйнівних змін**:

**Pure check (без IO)** — статичний аналіз кроків міграції: drop table → warning, drop column → warning, додавання NOT NULL без default → потенційно нездійсненна операція.

**IO check (з запитами до БД)** — перевіряє наявність даних: чи є рядки в таблиці, що видаляється; чи є NULL-значення в колонці, що стає NOT NULL.

| Зміна | Warning | Blocked |
|-------|---------|---------|
| Drop table | ⚠️ | — |
| Drop column | ⚠️ | — |
| Add required column (без default, таблиця з даними) | — | ❌ |
| NOT NULL на колонку з NULL-значеннями | — | ❌ |
| Зміна типу колонки (lossy cast) | ⚠️ | — |

### Shadow database — чисте середовище для diff

Shadow database — **тимчасова порожня БД**, що створюється під час `prisma migrate dev`. Вона потрібна для двох цілей:

**Drift detection:** всі існуючі міграції відтворюються на shadow DB → інтроспекція → порівняння з dev DB → виявлення ручних змін.

**Migration generation:** кінцевий стан shadow DB (після всіх міграцій) = "from"; поточна .prisma-схема = "to"; diff → нова міграція.

```
prisma migrate dev:
1. CREATE DATABASE prisma_shadow_<random>
2. Replay ALL migrations на shadow DB
3. Introspect shadow DB → expected state
4. Introspect dev DB → actual state
5. Diff expected vs actual → drift detection
6. Shadow DB state = "from", .prisma = "to" → new migration
7. Apply migration to dev DB
8. DROP shadow database
```

Shadow DB **не використовується** у production (`prisma migrate deploy` працює без неї).

### Обмеження Prisma

**Критичне:** Prisma **не розпізнає rename** — перейменування моделі/поля інтерпретується як drop + create з втратою даних. Потрібно ручне редагування SQL (`--create-only`). Також: **немає data-міграцій** (тільки DDL), **немає down-міграцій** за замовчуванням, повний **reset бази при drift**, shadow DB потребує **CREATEDB привілеї**. Таблиця `_prisma_migrations` з SHA-256 checksums відстежує застосовані міграції.

---

## D. EF Core Migrations — програмний ModelDiffer для .NET

### ModelDiffer: ієрархічний diff двох IRelationalModel

`MigrationsModelDiffer` — ядро порівняння схем в EF Core. Він порівнює два `IRelationalModel` (реляційне представлення моделі) і повертає список `MigrationOperation`:

```csharp
public interface IMigrationsModelDiffer
{
    bool HasDifferences(IRelationalModel? source, IRelationalModel? target);
    IReadOnlyList<MigrationOperation> GetDifferences(
        IRelationalModel? source, IRelationalModel? target);
}
```

Алгоритм **ієрархічного diff** обробляє об'єкти в порядку: таблиці → колонки → індекси → FK → послідовності → seed data. Для зіставлення використовується метод `DiffCollection<T>` з масивом предикатів зменшуваної специфічності (спочатку точний матч за schema+name, потім за entity type).

Після diff виконується **топологічне сортування** операцій: CREATE TABLE для таблиць з FK повинен йти після створення referenced таблиці. Циклічні FK-залежності обробляються виносом `AddForeignKeyOperation` за межі `CreateTable`.

### Формат міграцій — три C#-файли

Кожна міграція генерує три файли:

```csharp
// 1. Основний файл: Up() + Down()
public partial class CreateProducts : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Products",
            columns: table => new
            {
                Id = table.Column<int>(type: "integer", nullable: false)
                    .Annotation("Npgsql:ValueGenerationStrategy",
                        NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                Name = table.Column<string>(type: "character varying(100)",
                    maxLength: 100, nullable: false),
                Price = table.Column<decimal>(type: "numeric(18,2)",
                    precision: 18, scale: 2, nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Products", x => x.Id);
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "Products");
    }
}

// 2. Designer.cs — метадані + модель на момент міграції
// 3. ModelSnapshot.cs — кумулятивний знімок (оновлюється кожну міграцію)
```

### NpgsqlMigrationsSqlGenerator — PostgreSQL-специфічна генерація

`NpgsqlMigrationsSqlGenerator` наслідує базовий `MigrationsSqlGenerator` і переписує генерацію для PostgreSQL-специфічних фіч:

```csharp
public class NpgsqlMigrationsSqlGenerator : MigrationsSqlGenerator
{
    // IDENTITY замість SERIAL
    // "Id" integer GENERATED BY DEFAULT AS IDENTITY
    // "Id" integer GENERATED ALWAYS AS IDENTITY

    // PostgreSQL extensions
    // CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    // Sequence bumping після seeding
    // SELECT setval(pg_get_serial_sequence('"table"', 'col'), MAX("col")) FROM "table";

    // Schema creation
    // CREATE SCHEMA IF NOT EXISTS "myschema";
}
```

Заміна генератора: `options.UseNpgsql(conn).ReplaceService<IMigrationsSqlGenerator, MyCustomGenerator>()`.

### Програмне створення моделі без entity-класів

**Це ключова можливість для нашого конфігуратора.** EF Core дозволяє створювати entity types без CLR-класів:

```csharp
// Крок 1: Налаштування провайдера
var optionsBuilder = new DbContextOptionsBuilder();
optionsBuilder.UseNpgsql("Host=localhost;Database=test");
using var context = new DbContext(optionsBuilder.Options);
var serviceProvider = ((IInfrastructure<IServiceProvider>)context).Instance;

// Крок 2: Побудова моделі без entity-класів
var conventionSet = serviceProvider
    .GetRequiredService<IConventionSetBuilder>().CreateConventionSet();
var modelBuilder = new ModelBuilder(conventionSet);

modelBuilder.Entity("Product", b =>
{
    b.Property<int>("Id").ValueGeneratedOnAdd();
    b.Property<string>("Name").IsRequired().HasMaxLength(200);
    b.Property<decimal>("Price").HasPrecision(18, 2);
    b.HasKey("Id");
    b.ToTable("Products");
});

modelBuilder.Entity("Category", b =>
{
    b.Property<int>("Id").ValueGeneratedOnAdd();
    b.Property<string>("Name").IsRequired().HasMaxLength(50);
    b.HasKey("Id");
    b.ToTable("Categories");
});

// FK без CLR-навігації
modelBuilder.Entity("Product", b =>
{
    b.Property<int>("CategoryId");
    b.HasOne("Category").WithMany().HasForeignKey("CategoryId");
});

// Крок 3: Фіналізація та diff
var model = modelBuilder.FinalizeModel();
model = serviceProvider.GetRequiredService<IModelRuntimeInitializer>()
    .Initialize(model);

var differ = serviceProvider.GetRequiredService<IMigrationsModelDiffer>();
var operations = differ.GetDifferences(null, model.GetRelationalModel());

// Крок 4: Генерація SQL
var sqlGenerator = serviceProvider.GetRequiredService<IMigrationsSqlGenerator>();
var commands = sqlGenerator.Generate(operations, model);

foreach (var cmd in commands)
    Console.WriteLine(cmd.CommandText);
```

### Обмеження EF Core

**IMigrationsModelDiffer — internal API** (атрибут `[EntityFrameworkInternal]`), може змінитися без попередження між версіями. EF Core **не розпізнає rename** (генерує drop+add замість rename). ModelSnapshot.cs — джерело **merge-конфліктів** у командній роботі. EF Core не підтримує нативно: тригери, stored procedures, RLS, materialized views — тільки через `migrationBuilder.Sql(...)`. Оновлення Npgsql-версій може спричинити **фантомні diff** (зміна маппінгу типів).

---

## E. PostgreSQL DDL generation patterns

### Повна інтроспекція схеми — SQL-запити

**Таблиці з метаданими:**
```sql
SELECT
  c.oid AS id,
  n.nspname AS schema,
  c.relname AS name,
  pg_get_userbyid(c.relowner) AS owner,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  pg_table_size(c.oid) AS bytes,
  pg_size_pretty(pg_table_size(c.oid)) AS size,
  s.n_live_tup AS live_rows_estimate,
  s.n_dead_tup AS dead_rows_estimate,
  obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'p')  -- regular + partitioned
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname;
```

**Колонки з повними деталями:**
```sql
SELECT
  a.attrelid AS table_id,
  n.nspname AS schema,
  c.relname AS table,
  a.attnum AS ordinal_position,
  a.attname AS name,
  format_type(a.atttypid, a.atttypmod) AS data_type,
  t.typname AS format,
  NOT a.attnotnull AS is_nullable,
  pg_get_expr(d.adbin, d.adrelid) AS default_value,
  CASE a.attidentity
    WHEN 'a' THEN 'ALWAYS'
    WHEN 'd' THEN 'BY DEFAULT'
    ELSE NULL
  END AS identity_generation,
  a.attgenerated != '' AS is_generated,
  col_description(a.attrelid, a.attnum) AS comment,
  -- Enum values якщо тип є enum
  CASE WHEN t.typtype = 'e' THEN
    (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
     FROM pg_enum e WHERE e.enumtypid = t.oid)
  ELSE NULL END AS enum_values
FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attnum > 0
  AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY a.attrelid, a.attnum;
```

**Обмеження (PK, FK, UNIQUE, CHECK):**
```sql
SELECT
  con.oid AS id,
  con.conname AS name,
  n.nspname AS schema,
  c.relname AS table_name,
  con.contype AS type,  -- 'p'=PK, 'f'=FK, 'u'=UNIQUE, 'c'=CHECK
  pg_get_constraintdef(con.oid) AS definition,
  con.conkey AS column_indices,
  -- FK-специфічні поля:
  fc.relname AS referenced_table,
  fn.nspname AS referenced_schema,
  con.confkey AS referenced_column_indices,
  CASE con.confupdtype
    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END AS update_action,
  CASE con.confdeltype
    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END AS delete_action
FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = con.connamespace
  LEFT JOIN pg_class fc ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema');
```

**Індекси:**
```sql
SELECT
  i.indexrelid AS id,
  ic.relname AS name,
  n.nspname AS schema,
  tc.relname AS table_name,
  pg_get_indexdef(i.indexrelid) AS definition,
  am.amname AS method,      -- btree, hash, gin, gist, brin
  i.indisunique AS is_unique,
  i.indisprimary AS is_primary,
  i.indisvalid AS is_valid
FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = ic.relnamespace
  JOIN pg_am am ON am.oid = ic.relam
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema');
```

**Enum types:**
```sql
SELECT
  t.oid AS id,
  n.nspname AS schema,
  t.typname AS name,
  array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typtype = 'e'
GROUP BY t.oid, n.nspname, t.typname;
```

**RLS-політики:**
```sql
SELECT
  pol.oid AS id,
  n.nspname AS schema,
  c.relname AS table_name,
  pol.polname AS name,
  CASE pol.polcmd
    WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
    WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL'
  END AS command,
  pol.polpermissive AS is_permissive,
  pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expression,
  array(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)) AS roles
FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace;
```

### Best practices генерації DDL

**CREATE TABLE з правильним порядком:**
```sql
CREATE TABLE "inventory"."products" (
  -- Колонки
  "id"          integer GENERATED ALWAYS AS IDENTITY,
  "name"        varchar(200) NOT NULL,
  "sku"         varchar(50) NOT NULL,
  "price"       numeric(18,2) NOT NULL,
  "category_id" integer,
  "tags"        text[] DEFAULT '{}',
  "metadata"    jsonb DEFAULT '{}',
  "status"      inventory.product_status NOT NULL DEFAULT 'draft',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  -- Table-level constraints
  CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "products_sku_unique" UNIQUE ("sku"),
  CONSTRAINT "products_price_check" CHECK ("price" >= 0),
  CONSTRAINT "products_category_fkey"
    FOREIGN KEY ("category_id") REFERENCES "inventory"."categories"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Індекси окремо (дозволяє CONCURRENTLY)
CREATE INDEX "idx_products_category" ON "inventory"."products" ("category_id");
CREATE INDEX "idx_products_tags" ON "inventory"."products" USING gin ("tags");
CREATE INDEX "idx_products_metadata" ON "inventory"."products" USING gin ("metadata");
CREATE INDEX "idx_products_name_search" ON "inventory"."products"
  USING gin (to_tsvector('english', "name"));

-- Коментарі
COMMENT ON TABLE "inventory"."products" IS 'Каталог продуктів';
COMMENT ON COLUMN "inventory"."products"."sku" IS 'Stock Keeping Unit';
```

**ALTER TABLE з мінімальними breaking changes:**
```sql
-- Додавання колонки (безпечне)
ALTER TABLE "products" ADD COLUMN "description" text;

-- Безпечне додавання NOT NULL (спочатку default, потім constraint)
ALTER TABLE "products" ADD COLUMN "weight" numeric(10,2) DEFAULT 0 NOT NULL;
-- або для існуючої колонки:
ALTER TABLE "products" ALTER COLUMN "description" SET DEFAULT '';
UPDATE "products" SET "description" = '' WHERE "description" IS NULL;
ALTER TABLE "products" ALTER COLUMN "description" SET NOT NULL;

-- Зміна типу з USING для безпечного cast
ALTER TABLE "products" ALTER COLUMN "price"
  TYPE numeric(20,4) USING "price"::numeric(20,4);

-- Enum: додавання значення (не можна видалити!)
ALTER TYPE inventory.product_status ADD VALUE IF NOT EXISTS 'archived';

-- Видалення колонки (з попередженням)
ALTER TABLE "products" DROP COLUMN IF EXISTS "legacy_field" CASCADE;
```

**Робота з enum, array, JSONB:**
```sql
-- Enum
CREATE TYPE inventory.product_status AS ENUM ('draft', 'active', 'archived');
-- Rename enum value (PostgreSQL 10+)
ALTER TYPE inventory.product_status RENAME VALUE 'draft' TO 'inactive';
-- Видалити значення неможливо — потрібна пересоздання типу через транзакцію

-- Array columns
"tags" text[] DEFAULT '{}',
-- Array index
CREATE INDEX idx_tags ON products USING gin ("tags");
-- Array query pattern
WHERE 'urgent' = ANY("tags")

-- JSONB
"metadata" jsonb DEFAULT '{}',
-- GIN index для JSONB
CREATE INDEX idx_metadata ON products USING gin ("metadata");
-- Partial JSONB index
CREATE INDEX idx_active_metadata ON products USING gin ("metadata")
  WHERE "status" = 'active';
```

**Генерація індексів:**
```sql
-- B-tree (за замовчуванням, для =, <, >, BETWEEN)
CREATE INDEX idx_name ON products ("name");

-- Unique index
CREATE UNIQUE INDEX idx_sku ON products ("sku");

-- Partial index (тільки активні)
CREATE INDEX idx_active ON products ("created_at") WHERE "status" = 'active';

-- Expression index
CREATE INDEX idx_lower_name ON products (lower("name"));

-- CONCURRENTLY (не блокує таблицю, тільки поза транзакцією)
CREATE INDEX CONCURRENTLY idx_price ON products ("price");

-- Composite
CREATE INDEX idx_category_status ON products ("category_id", "status");

-- GiST (для range types, geometry)
CREATE INDEX idx_period ON events USING gist ("period");
```

---

## F. Зведена таблиця порівняння підходів

| Критерій | pg_meta | Drizzle Kit | Prisma Migrate | EF Core |
|----------|---------|-------------|----------------|---------|
| **Мова** | TypeScript | TypeScript | Rust | C# |
| **Ліцензія** | Apache 2.0 | Apache 2.0 | Apache 2.0 | MIT |
| **Schema introspection** | pg_catalog SQL-запити (повна інтроспекція) | Серіалізація TS-коду в JSON + інтроспекція БД | sql-schema-describer (Rust, per-dialect) | IRelationalModel від conventions |
| **Schema diff** | Немає (тільки CRUD) | JSON snapshot diff з squashing | SqlSchema differ (Rust) | MigrationsModelDiffer (ієрархічний) |
| **DDL generation** | Template literals + pg-format | Convertor registry pattern | per-dialect sql_renderer | MigrationsSqlGenerator (override per provider) |
| **Migration format** | Немає (прямий DDL) | SQL-файли + JSON snapshots + journal | SQL-файли + _prisma_migrations table | C# класи (Up/Down) + ModelSnapshot |
| **Rename detection** | N/A (CRUD) | Інтерактивні resolver prompts | ❌ Не підтримується | ❌ Не підтримується |
| **Destructive changes** | Немає захисту | Немає спеціальної обробки | Двофазна перевірка (pure + IO) | Немає вбудованої перевірки |
| **RLS/triggers/functions** | ✅ Повна підтримка | ✅ Policies, partial | ❌ Не підтримується | ❌ Тільки через raw SQL |
| **PostgreSQL-специфічність** | Повна | Висока | Середня (multi-DB) | Низька (через Npgsql) |
| **Що запозичити** | SQL-запити інтроспекції, модель даних | Snapshot diff, resolver pattern, Convertor IR | Shadow DB, destructive check, trait architecture | Програмний ModelBuilder, SQL generator pattern |

### Рекомендована архітектура для .NET-реалізації

На основі аналізу всіх чотирьох інструментів, оптимальна архітектура для .NET-конфігуратора поєднує найкращі підходи:

```
┌─────────────────────────────────────────────────────────────┐
│                    React UI (конфігуратор)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST API
┌──────────────────────────▼──────────────────────────────────┐
│                   ASP.NET Core API                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ SchemaIntrospector  (← від pg_meta: SQL-запити)      │   │
│  │ • Npgsql + embedded .sql files                        │   │
│  │ • C# record types для Table, Column, Index, FK...    │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                    │
│  ┌──────────────────────▼───────────────────────────────┐   │
│  │ SchemaSnapshot   (← від Drizzle: JSON snapshot)      │   │
│  │ • Серіалізація стану в JSON                           │   │
│  │ • Версіонування snapshot формату                      │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                    │
│  ┌──────────────────────▼───────────────────────────────┐   │
│  │ SchemaDiffer     (← від Drizzle + EF Core)           │   │
│  │ • JSON diff squashed snapshots                        │   │
│  │ • Resolver pattern для rename                         │   │
│  │ • Dependency-ordered multi-phase diff                 │   │
│  │ • Output: DiffOperation[] (typed IR)                  │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                    │
│  ┌──────────────────────▼───────────────────────────────┐   │
│  │ DestructiveChangeChecker (← від Prisma)              │   │
│  │ • Pure check (static analysis)                        │   │
│  │ • IO check (queries DB for data presence)             │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                    │
│  ┌──────────────────────▼───────────────────────────────┐   │
│  │ DdlGenerator     (← від Drizzle: Convertor pattern) │   │
│  │ • Registry of IStatementConvertor implementations     │   │
│  │ • pg-format escaping → NpgsqlConnection.EscapeIdent() │   │
│  │ • Output: SQL migration files                         │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                    │
│  ┌──────────────────────▼───────────────────────────────┐   │
│  │ MigrationRunner  (← від Prisma + EF Core)            │   │
│  │ • Tracking table (_migrations)                        │   │
│  │ • SHA-256 checksum verification                       │   │
│  │ • Transaction-per-migration                           │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Конкретні кроки реалізації для .NET/C#

**1. Schema Introspection Module** — скопіювати SQL-запити з pg_meta, обгорнути в C#-сервіс з Npgsql:

```csharp
public interface ISchemaIntrospector
{
    Task<IReadOnlyList<TableInfo>> GetTablesAsync(string schema = "public");
    Task<IReadOnlyList<ColumnInfo>> GetColumnsAsync(long tableId);
    Task<IReadOnlyList<ConstraintInfo>> GetConstraintsAsync(long tableId);
    Task<IReadOnlyList<IndexInfo>> GetIndexesAsync(long tableId);
    Task<IReadOnlyList<EnumTypeInfo>> GetEnumTypesAsync(string schema = "public");
    Task<IReadOnlyList<PolicyInfo>> GetPoliciesAsync(long tableId);
    Task<SchemaSnapshot> GetFullSnapshotAsync(params string[] schemas);
}
```

**2. Snapshot format** — адаптувати Drizzle-подібний JSON:

```csharp
public record SchemaSnapshot(
    string Version,           // "1"
    string Id,                // GUID
    string PrevId,            // GUID попереднього
    Dictionary<string, TableSnapshot> Tables,
    Dictionary<string, EnumSnapshot> Enums,
    Dictionary<string, SequenceSnapshot> Sequences,
    SnapshotMeta Meta         // rename mappings
);
```

**3. Schema Differ** — реалізувати diff з resolver-ін'єкцією:

```csharp
public interface ISchemaDiffer
{
    Task<IReadOnlyList<DiffOperation>> DiffAsync(
        SchemaSnapshot from,
        SchemaSnapshot to,
        IRenameResolver resolver);
}

public interface IRenameResolver
{
    Task<RenameResolution> ResolveTableRenameAsync(
        IReadOnlyList<string> deleted, IReadOnlyList<string> created);
    Task<RenameResolution> ResolveColumnRenameAsync(
        string tableName, IReadOnlyList<string> deleted, IReadOnlyList<string> created);
}
```

**4. DDL Generator** — Convertor registry:

```csharp
public interface IDdlConvertor
{
    bool CanConvert(DiffOperation operation);
    string Convert(DiffOperation operation);
}

public class DdlGenerator
{
    private readonly IReadOnlyList<IDdlConvertor> _convertors;

    public IReadOnlyList<string> Generate(IReadOnlyList<DiffOperation> operations)
        => operations.Select(op =>
            _convertors.First(c => c.CanConvert(op)).Convert(op)).ToList();
}
```

**5. Альтернативний шлях — використання EF Core ModelBuilder** як diff-engine:

```csharp
// Конфігуратор генерує метадані → ModelBuilder будує IModel →
// IMigrationsModelDiffer порівнює → IMigrationsSqlGenerator генерує SQL
// Перевага: не потрібно писати власний differ
// Недолік: internal API, обмежена підтримка PG-специфічних фіч
```

### Висновок

Оптимальний підхід для .NET-конфігуратора — **гібридна стратегія**: взяти SQL-запити інтроспекції з pg_meta (вони переносяться 1:1), реалізувати snapshot-based diff за патерном Drizzle Kit (з resolver-ін'єкцією для rename та squashing для ефективного порівняння), додати двофазну перевірку руйнівних змін за патерном Prisma, і використовувати Convertor registry для генерації SQL. EF Core ModelBuilder можна використовувати як **fallback diff-engine** для складних випадків, але з усвідомленням що це internal API. Ключовий інсайт: жоден з досліджених інструментів не вирішує rename-проблему автоматично — Drizzle Kit запитує користувача, Prisma і EF Core просто ігнорують. Інтерактивний resolver Drizzle Kit — найкращий підхід для UI-конфігуратора, де rename можна вирішувати візуально через drag-and-drop.