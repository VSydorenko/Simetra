# П2, план E2b — зворотна генерація, повний round-trip, `simetra introspect`/`simetra diff`: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** живу базу можна прочитати в метадані Simetra і порівняти з
метаданими: зворотний генератор (модель каталогу порту → `CustomTable`,
`PgEnum`, дослівний `*.sql`), повний round-trip `extract → зворотна
генерація → компіляція → рендер → тінь` з порожньою звіркою, фікстури за
класами, інструменти каталогу `introspect` і `diff` у `@simetra/designer` і
процедура приватної звірки на schema-only копії першого споживача.

**Архітектура:** зворотний генератор — чиста функція T2
(`simetra/schema`, `src/schema/reverse/`) над `CatalogModel` з E2a: без бази,
без диска; ідентичності й `$schema` доповнює той самий прохід T1, що й
`fix`. Підключення до бази й тінь — справа інструментів `@simetra/designer`,
які складають адаптер pg-delta, порт T2 і генератор. Модель дозволів
каталогу перебудовується за принципом «тертя пропорційне незворотності».

**Технології:** TypeScript 7, Vitest 5, пакети й піни — як після designer-1
і E2a (`@supabase/pg-delta` 1.0.0-alpha.56, `pg` 8.23.1, citty 0.2.2,
`@modelcontextprotocol/server` 2.2.0); нових залежностей немає.

**Спека:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§3, §4, §8.6, §9, §10.3, §10.4; [спека designer](../specs/2026-10-02-simetra-designer-design.md)
§3.1–§3.2; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
§6.2, §6.4, §6.9; карта — [docs/architecture](../../architecture/README.md).

**Передумова:** E2a і designer-1 приземлено. Перед стартом — `orient --plan`
цього файлу. Вхідні борги — розділи «Рішення за спайком», «Уточнення під час
виконання» і «Поза E2a» [плану E2a](2026-10-02-p2e2a-schema-engine.md).

**Серія:** E2a → designer-1 → **E2b** (цей) → П3.

## Рішення плану

1. **Модель дозволів — тертя пропорційне незворотності** (рішення власника
   2026-10-02, погоджено з архітектором designer). Ознака інструмента — дві
   осі: `files: "read" | "write"` і `database: "none" | "read" | "write"`
   (замість `effect`, без шиму); `destructive` — окремо.
   - Запис файлів метаданих увімкнено за замовчуванням і в CLI, і в MCP:
     файли в git, а запис іде лише після чистої компіляції результату й лише
     в межах теки (`writeChanges`). `--allow-write` прибирається;
     `--read-only` вимикає запис, і відмова пояснює саме це.
   - Читання бази — без окремого дозволу. Невидимі агенту захисти: сесія
     цілі відкривається read-only (`default_transaction_read_only = on`);
     рядок підключення — лише із середовища, ім'я змінної фіксується при
     запуску (`--database-url-env <NAME>`, типово `SIMETRA_DATABASE_URL`),
     ніколи з входу інструмента; рядок і облікові дані не з'являються в
     жодному виводі, діагностиці чи помилці.
   - Тінь — co-located із ціллю (платформна спека §6.2) власною сесією з
     правом `CREATE DATABASE`; окреме джерело — опція `SIMETRA_SHADOW_URL`
     (`--shadow-url-env`). Імена тіней мають фіксований префікс і
     прибираються завжди.
   - Єдине тертя рівня файлів — `delete` (`confirm`/`--yes`): втрата
     ідентичності (UUID) переживає відкат файлів — наступний `create` видає
     новий UUID, і П3 спланує видалення таблиці з даними. `introspect` у
     непорожню теку — не руйнівний (git і dry-run). `database: "write"`
     (`apply`, П3) — власне підтвердження з показаним планом.
2. **Зворотний генератор — чистий T2** (`src/schema/reverse/`), вхід —
   `CatalogModel` (модель порту, не FactBase), вихід — мапа файлів і
   діагностика. Логічні імена — з фізичних: об'єкт — PascalCase, колонка —
   за `naming.attributeCase`; `physicalName` пишеться явно (= поточне ім'я),
   тож `fix` його не перепризначає (спека §3).
3. **Тип колонки — інверсія `pgTypeOf`** (`model/physical/pg-types.ts`):
   форма `format_type()`, що є образом логічного типу, стає логічним типом
   (`numeric(12,2)` → `Numeric` з `precision`/`scale`, `character varying(N)`
   → `String` з `length`, `integer[]` → `Integer` з `array`); тип енам-типу в
   межі — `PgEnum`; решта — `Raw` з `pgType`. `uuid` — завжди `UUID`, не
   `Ref`: тип посилання не розрізняє, FK описується окремо, як є (спека §9).
   Інваріант із тестом: `pgTypeOf(logicalTypeOf(t)) === t` для кожного образу.
4. **Розкладка SQL-одиниць** (спека §3): одиниця, що належить одній таблиці
   (тригер і політика на ній, грант на неї, її `replicaIdentity`,
   `sequenceOwnedBy` її колонки), — у `<Ім'я>.sql` її `CustomTable`; решта —
   `sql/<схема>/<ім'я>.sql`, одна одиниця на файл, перевантаження — суфікс
   типів аргументів; схема одиниці без власної схеми (грант на схему, ADP,
   розширення, publication) — схема цілі з дерева розбору, інакше
   `defaultSchema` проєкту. Об'єкти на таблицях провайдера (політика на
   `storage.objects`, тригер на `auth.users`) — у `sql/<схема провайдера>/`.
5. **Гучна помилка зворотної генерації** — діагностика T1 `introspect.unrepresentable`
   (error) з ім'ям об'єкта; разом з `engine.unrepresentable` extract-у
   `introspect` не пише нічого, якщо є хоч одна помилка. EXCLUDE-обмеження й
   інші невиражені класи лишаються гучними (форма EXCLUDE — рішення власника
   поза E2b).
6. **Нормалізація боргу F** (друга форма знімка при явному типовому опкласі
   чи колляції, асиметрія `deferrable`) — у генераторі: він пише лише
   нетипові значення, тож скомпільований знімок має одну форму на один стан.
7. **Запаркований Important E2a закривається першим** (задача 0): поверхня
   пресету провайдера — дані в `provider/supabase.ts`, а не перевірка за
   класом.

## Global Constraints

- Ярус: генератор — T2 `packages/simetra/src/schema/reverse/`, без `pg`,
  pg-delta, диска й Node API (інваріант E2a/designer-1 тримає лінт і
  `test/tier-boundary.test.ts`); інструменти й підключення — лише
  `packages/designer`.
- Нових залежностей немає; наявні піни — без змін.
- Тексти діагностик — `en`/`uk`/`hint` у `MESSAGES`, коди в `COMPILER_RULES`;
  описи інструментів і повідомлення CLI/MCP — англійською.
- Рядок підключення й облікові дані не з'являються у виводі, діагностиці,
  помилці чи відмові — перевіряє тест у задачі 5.
- Приватні дані першого споживача (дамп, згенеровані метадані, виходи
  звірки) не потрапляють у git; репо публічне.
- Коміти — Conventional Commits, опис українською, без трейлерів.
- Гейти в кожній задачі: scoped-тести, typecheck, lint, `pnpm format:check`;
  задачі 3–6 — ще `pnpm --filter @simetra/designer test:db`; перед
  фінальним рев'ю — повні кореневі гейти, `pnpm metadata:check`,
  `pnpm test:db`; після правок документів — `python3 scripts/check-doc-anchors.py`.

## Review Focus

1. **Round-trip не губить властивостей:** таблиця без PK, identity
   `ALWAYS`, `NULLS NOT DISTINCT`, виразний і частковий індекс, FK на
   `auth.users` проходять `extract → генерація → компіляція → тінь` з
   порожньою звіркою. Задача 4.
2. **Невиражене не стає тишею:** EXCLUDE-обмеження чи власник-не-сесія дає
   помилку, і `introspect` нічого не пише. Задачі 3 і 5.
3. **Пароль не витікає:** недосяжна база й хибний пароль дають повідомлення
   без рядка підключення. Задача 5.
4. **Повторний `introspect` у ту саму теку ідемпотентний:** id наявних
   елементів зберігаються (зіставлення за `physicalName`), другий прогін —
   нуль змін. Задача 5.
5. **GRANT/COMMENT на таблиці провайдера й політика на непередбаченій
   таблиці провайдера** не дають тихого «порожньо». Задача 0.

---

### Task 0: Поверхня пресету провайдера — даними, і дрібні борги E2a

**Files:**
- Modify: `packages/simetra/src/schema/engine/provider/supabase.ts`, `engine/desired.ts` (`outOfScopeDiagnostics`), `packages/simetra/src/compiler/messages.ts` (порядок `OUT_OF_SCOPE_REASONS` після `MESSAGES`, не між JSDoc і ним), `engine/port.ts` (JSDoc `withDesiredShadow` про фільтр `unmodeled_kind`)
- Test: `packages/simetra/src/schema/__tests__/out-of-scope.test.ts` (юніт); контрактний тест у `packages/designer/src/schema-engine/__tests__/engine-policy.test.ts`

**Interfaces:**
- Produces (`provider/supabase.ts`):
  ```ts
  interface ProviderSurface { schema: string; table: string /* glob, "*" — будь-яка */; classes: readonly ("policy" | "trigger")[] }
  const SUPABASE_SURFACES: readonly ProviderSurface[]
  const SUPABASE_ROLES: readonly string[]
  ```
  `outOfScopeDiagnostics` перевіряє ціль одиниці, а не лише клас: одиниця
  `policy`/`trigger` у схемі провайдера — лише на таблиці з поверхні;
  тригер на таблиці провайдера — лише з функцією поза схемами провайдера;
  одиниці `grant`/`comment` з порожньою `schema` — за схемою цілі з дерева
  розбору (грант чи коментар на таблиці провайдера → `engine.out-of-scope`).
- [ ] **Step 1: Тести** — `grant on a provider table is out of scope`;
  `comment on auth.users is out of scope`; `policy on an unforeseen provider
  table is out of scope` (`storage.migrations`); `trigger on auth.users with
  a function in extensions is out of scope`; `policy on storage.objects is
  in scope`; `ADP IN SCHEMA app gives no diagnostic`; контрактний —
  `surfaces match the engine preset` (рівність із правилом
  `supabase.user-policy-surface` закріпленої версії) і `extension list is
  not empty` (`toContain("pg_graphql")`).
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти обох пакетів.
- [ ] **Step 5: Commit** `fix(schema): поверхня пресету провайдера даними — ціль гранту, коментаря, політики й тригера`

---

### Task 1: Модель дозволів каталогу — дві осі, запис за замовчуванням

**Files:**
- Modify: `packages/designer/src/tools/types.ts` (`Effect` → `files`/`database`), `tools/invoke.ts` (`permits`), `tools/write-access.ts` (підказки з одного джерела), `tools/read.ts`, `tools/mutations.ts`, `src/cli/command.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/commands/mcp.ts`
- Modify: спека designer §3.1–§3.2; спека П2 §8.6; `docs/architecture/designer.md`; скіл `packages/designer/skills/simetra-metadata/SKILL.md`
- Test: `packages/designer/src/__tests__/catalog.test.ts`, `mcp.test.ts`, `cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type FilesAccess = "read" | "write"
  type DatabaseAccess = "none" | "read" | "write"
  interface Tool<I, D> { name: ToolName; description: string; input: I
    files: FilesAccess; database: DatabaseAccess; destructive: boolean
    run(ctx: ToolContext, input: z.infer<I>): Promise<RunOutcome<D>> }
  interface ToolContext { dir: string; database?: DatabaseContext }      // DatabaseContext — задача 5
  interface InvokeOptions { dir: string; readOnly: boolean; dryRun: boolean; confirmed: boolean; launchArgs?: readonly string[] }
  function permits(tool: Tool, o: { readOnly: boolean }): boolean       // вичерпний switch по обох осях
  const READ_ONLY_FLAG = "--read-only"
  function readOnlyHint(launchArgs?: readonly string[]): string          // одне джерело для isError і instructions
  ```
  `RefusalReason` `"write-disabled"` → `"read-only"`. Рядок спеки П2 §8.6
  «у П2 MCP до бази не звертається взагалі» замінюється правилом рішення
  плану 1 (читання — лише read-only сесією; рядок підключення — лише з
  середовища; запис у базу — П3 з підтвердженням).
- [ ] **Step 1: Тести** — `every (files, database) pair in TOOLS has a
  permit rule`; `writes are on by default in mcp and cli`; `--read-only
  refuses a write and explains the flag`; `delete still needs confirm`;
  `tools/list does not change with --read-only`.
- [ ] **Step 2–4:** червоні → реалізація (без шиму `--allow-write`) →
  зелені, гейти.
- [ ] **Step 5:** правки спек і `docs/architecture/designer.md`;
  `check-doc-anchors.py`. Текст правки спеки designer — до виконання
  переглядає архітектор designer (`simetra-designer-spec`).
- [ ] **Step 6: Commit** `feat(designer): дві осі дозволів, запис за замовчуванням, --read-only`

---

### Task 2: Інверсії T0 — логічне ім'я з фізичного, логічний тип з `format_type()`

**Files:**
- Modify: `packages/simetra/src/model/schemas/identity.ts`, `src/model/physical/pg-types.ts`, `src/model/index.ts`
- Test: `packages/simetra/src/model/__tests__/identity-inverse.test.ts`, `pg-types-inverse.test.ts`

**Interfaces:**
- Produces (`simetra/model`):
  ```ts
  function logicalObjectName(physical: string): string                       // snake → PascalCase; результат проходить objectNameSchema
  function logicalElementName(physical: string, style: AttributeCase): string // camelCase чи як є для snake_case
  type ColumnTypeForm =
    | { type: LogicalType; length?: number; precision?: number; scale?: number; array?: true }
    | { type: "PgEnum"; enum: { schema: string; name: string } }
    | { type: "Raw"; pgType: string }
  function logicalTypeOf(formatType: string, enumTypes: ReadonlySet<string> /* "schema.name" в межі */): ColumnTypeForm
  ```
  Правило — рішення плану 3; `Ref` не виводиться ніколи. Ім'я, яке після
  перетворення не проходить схему (цифра на початку, зарезервоване), —
  детермінований суфікс, з тестом на кожен випадок.
- [ ] **Step 1: Тести** — `snake to Pascal` (`service_accrual` →
  `ServiceAccrual`); `snake to camel` і `snake stays snake`; `inverse of
  pgTypeOf is exact` (для кожного логічного типу й параметрів:
  `pgTypeOf(logicalTypeOf(pgTypeOf(t))) === pgTypeOf(t)`); `uuid is UUID`;
  `unknown type is Raw` (`timestamp without time zone`, `citext`, `json`);
  `enum in scope is PgEnum`; `numeric without scale`.
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(model): логічні імена й типи з фізичних — інверсії для зворотної генерації`

---

### Task 3: Зворотний генератор (T2, чистий)

**Files:**
- Create: `packages/simetra/src/schema/reverse/generate.ts`, `reverse/tables.ts`, `reverse/units.ts`, `reverse/index.ts`
- Modify: `packages/simetra/src/schema/index.ts`, `compiler/diagnostics.ts`, `messages.ts` (`introspect.unrepresentable`)
- Test: `packages/simetra/src/schema/__tests__/reverse-generate.test.ts` (юніт над `CatalogModel`-літералами)

**Interfaces:**
- Consumes: `CatalogModel` (T0), `logicalObjectName`, `logicalElementName`, `logicalTypeOf` (задача 2), `completeFiles` (`compiler/operations/fix.ts`), `formatMetaFile`, `formatProjectFile`, `loadSqlParser` (для схеми цілі гранту/коментаря).
- Produces (`simetra/schema`):
  ```ts
  interface ReverseOptions {
    project: { name: string; defaultSchema: string; attributeCase: AttributeCase }
    existing: ReadonlyMap<string, string>          // наявна тека метаданих (може бути порожня)
    newId: IdSource; schemaPath: SchemaPathResolver
  }
  interface ReverseResult { files: Map<string, string>; diagnostics: Diagnostic[] }
  function reverseGenerate(model: CatalogModel, o: ReverseOptions): Promise<ReverseResult>
  ```
  Таблиця → `custom-tables/<Ім'я>/<Ім'я>.meta.json` (`physicalName` = ім'я,
  `schema` — якщо не `defaultSchema`, імена обмежень та індексів явні, FK на
  таблицю в межі — `{ object: { kind: "CustomTable", name } }` з логічними
  колонками, інакше `{ external: { schema, table, columns } }`); енам-тип →
  `pg-enums/<Ім'я>/<Ім'я>.meta.json`; одиниці — за рішенням плану 4.
  Ідентичність зберігається: елемент, чий `physicalName` є в `existing`,
  отримує наявний `id`; новий — `newId`. Невиражене — `introspect.unrepresentable`.
  Порожній `existing` → створюється `project.meta.json` з `project`.
- [ ] **Step 1: Тести** — `table becomes a CustomTable with explicit names`;
  `fk to a managed table uses object ref, to auth.users external`;
  `enum type becomes PgEnum and its columns reference it`; `trigger, policy
  and grant on a table go to its sidecar`; `function goes to
  sql/<schema>/<name>.sql with an overload suffix`; `schema grant and ADP go
  to the target schema`; `existing ids are kept by physicalName`; `default
  opclass, collation and deferrable are omitted` (рішення плану 6);
  `exclude constraint is unrepresentable`; `output compiles` (компіляція
  `files` → `ok`, нуль помилок).
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(schema): зворотний генератор — модель каталогу в CustomTable, PgEnum і дослівний SQL`

---

### Task 4: Повний round-trip і фікстури класів

**Files:**
- Create: `packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts`, `__tests__/fixtures/round-trip-classes.ts`
- Modify: спека П2 §9 (рядок про інваріанти зворотної генерації: `uuid` → `UUID`, розкладка одиниць, збереження id за `physicalName`), `docs/architecture/metadata-pipeline.md`

- [ ] **Step 1: Тести.** Помічник: ціль — тінь із SQL фікстури
  (`withDesiredShadow` від бази стеку) → `extract` → `reverseGenerate` →
  `compile` (`ok`, нуль помилок) → `renderDesiredState` →
  `compareWithDesired(ціль, рендер)` → `empty`. Корпус:
  - класи спеки §9 (Review Focus 1): виразний і частковий індекс,
    `NULLS NOT DISTINCT`, таблиця без PK, identity `ALWAYS`, FK на
    `auth.users`; плюс енам-тип, тригер з функцією, політика, грант,
    коментар таблиці й колонки, послідовність `OWNED BY`, `REPLICA
    IDENTITY FULL`, ADP;
  - корпус E1 (`FIXTURES`) і синтетичний домен: рендер E1 → ціль → повний
    round-trip → `empty` (види 1С повертаються як `CustomTable` з тими самими
    фізичними іменами);
  - гучні (Review Focus 2): EXCLUDE → `introspect.unrepresentable` /
    `engine.unrepresentable` з ім'ям; власник-не-сесія → `engine.unrepresentable`;
    cast → `engine.unmodeled-class`.
- [ ] **Step 2:** `pnpm --filter @simetra/designer test:db round-trip` —
  зелено; час db-проєкту в звіті.
- [ ] **Step 3:** правки спеки §9 і карти; `check-doc-anchors.py`.
- [ ] **Step 4: Commit** `test(designer): повний round-trip extract → зворотна генерація → тінь на фікстурах класів і корпусі`

---

### Task 5: Інструменти каталогу `introspect` і `diff`

**Files:**
- Create: `packages/designer/src/tools/database.ts` (інструменти), `packages/designer/src/io/database.ts` (`DatabaseContext`, джерело рядка, редагування)
- Modify: `tools/types.ts` (`TOOL_NAMES`), `tools/catalog.ts`, `src/cli/command.ts`, `src/cli/input.ts`, `src/cli/render.ts`, `src/mcp/tools.ts` (`toResponse`), `src/commands/mcp.ts` (`--database-url-env`, `--shadow-url-env`), `packages/designer/src/schema-engine/pg-delta/adapter.ts` (read-only сесія цілі), `packages/simetra/src/schema/engine/port.ts` (`withDesiredShadow(target, desiredSql, scope, fn, shadowBase?: DbConnection)` — без `shadowBase` тінь co-located із ціллю)
- Modify: спека П2 §8.6–§8.7 (інструменти `introspect`/`diff`), `docs/architecture/designer.md`, скіл `simetra-metadata`
- Test: `packages/designer/src/__tests__/database-tools.db.test.ts`, `database-redaction.test.ts`, оновлений бюджет `tools/list` у `mcp.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface DatabaseContext { target: DbConnection; shadowBase?: DbConnection; describe: string /* без облікових даних */ }
  function databaseFromEnv(env: NodeJS.ProcessEnv, names: { url: string; shadow?: string }): DatabaseContext | undefined
  function redact(text: string, ctx: DatabaseContext): string
  // інструменти:
  // introspect — files: "write", database: "read", destructive: false; вхід { schemas?: string[] } (типово — схеми з project.meta.json теки або "public")
  // diff       — files: "read",  database: "read", destructive: false; вхід {}
  ```
  `introspect`: extract цілі (read-only сесія) → `reverseGenerate` з
  наявною текою → запис лише при нулі помилок (рішення плану 5); `diff`:
  компіляція теки → рендер → `compareWithDesired` → дані `{ plan, differences,
  diagnostics, empty }`. CLI: `simetra introspect [dir]`, `simetra diff
  [dir]` (`--database-url-env`, `--shadow-url-env`, `--format`); коди: 0 —
  порожньо / записано, 1 — відмінності чи помилки, 2 — немає змінної
  середовища, недосяжна база, помилка використання. MCP: інструменти видимі
  завжди; без змінної середовища — `isError` з підказкою, яку змінну задати
  (одне джерело з `readOnlyHint`). Тінь — `shadowBase` або co-located.
- [ ] **Step 1: Тести** — `introspect writes metadata that compiles`;
  `introspect twice changes nothing` (Review Focus 4); `introspect with
  errors writes nothing`; `diff of an introspected database is empty`;
  `diff names a dropped index`; `target session is read-only` (спроба
  `CREATE TABLE` через пул цілі адаптера падає); `missing env var exits 2
  and names the variable`; `bad password is redacted` (Review Focus 3:
  повідомлення не містить пароля й рядка); `no shadow is left behind`;
  перемір бюджету `tools/list` — свідомий, з коментарем «перевиміряно в
  E2b: <число>».
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти, `test:db`.
- [ ] **Step 5: Commit** `feat(designer): інструменти introspect і diff над портом SchemaEngine`

---

### Task 6: Процедура приватної звірки, канон, ROADMAP

**Files:**
- Create: `.agents/skills/consumer-reconciliation/SKILL.md` (+ симлінк `.claude/skills/consumer-reconciliation`), запис у skill mappings `AGENTS.md`
- Modify: спека П2 §10.3 (команди звірки), `docs/ROADMAP.md`

- [ ] **Step 1:** скіл (англійською, для агентів платформи): відновити
  schema-only дамп першого споживача в **окрему** локальну базу стеку
  (ніколи не в базу тестів), `simetra introspect` у теку **поза репо**,
  `simetra diff`, що вважається проходженням за §10.3 і §10.2/М4, куди
  кладуться виходи (репо споживача), заборона комітити будь-що з них сюди;
  посилання на спеку без переказу. `check-doc-anchors.py`.
- [ ] **Step 2:** ROADMAP: план E2b у рядку П2, «Зараз» — E2b виконано,
  далі приватна звірка (дамп від власника) і П3.
- [ ] **Step 3:** повні кореневі гейти, `pnpm metadata:check`, `pnpm test:db`.
- [ ] **Step 4: Commit** `docs(skill): процедура приватної звірки першого споживача; канон E2b`

---

## Поза E2b

- Сам прогін приватної звірки на дампі MetaHub — після E2b, з дампом від
  власника; виходи поза репо.
- Форма EXCLUDE-обмежень у моделі — рішення власника.
- Прибирання тіней-сиріт після сигналу — П3.
- Час db-проєкту (тінь на фікстуру) — борг E2a.

## Критерії приймання плану E2b

- Повний round-trip порожній на фікстурах класів спеки §9, корпусі E1 і
  синтетичному домені; невиражене — гучна помилка.
- `simetra introspect`/`simetra diff` працюють у CLI й MCP над будь-якою
  досяжною базою, сесія цілі read-only, облікові дані не витікають.
- Модель дозволів: запис файлів за замовчуванням, `--read-only`, `delete` з
  підтвердженням; осі дозволів вичерпні.
- Поверхня пресету провайдера — даними; тиха порожнеча E2a закрита.
