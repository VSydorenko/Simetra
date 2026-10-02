# П2, план E2b — зворотна генерація, повний round-trip, `simetra introspect`/`simetra diff`: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** живу базу можна прочитати в метадані Simetra і порівняти з
метаданими: зворотний генератор (модель каталогу порту → `CustomTable`,
`PgEnum`, дослівний `*.sql`), повний round-trip `extract → зворотна
генерація → компіляція → рендер → тінь` з порожньою звіркою, підтвердженою
незалежним оракулом, інструменти каталогу `introspect` і `diff` у
`@simetra/designer` і процедура приватної звірки першого споживача (§10.3).

**Архітектура:** зворотний генератор — чиста функція T2
(`simetra/schema`, `src/schema/reverse/`) над `CatalogModel` з E2a: без бази,
без диска. Підключення до бази, тінь і запис — справа інструментів
`@simetra/designer`, які складають адаптер pg-delta, порт T2 і генератор.
Модель дозволів каталогу перебудовується за принципом «тертя пропорційне
незворотності».

**Технології:** TypeScript 7, Vitest 5, пакети й піни — як після designer-1
і E2a (`@supabase/pg-delta` 1.0.0-alpha.56, `pg` 8.23.1, citty 0.2.2,
`@modelcontextprotocol/server` 2.2.0); нових залежностей немає.

**Спека:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§3, §4, §8.6, §9, §10.2, §10.3, §10.4; [спека designer](../specs/2026-10-02-simetra-designer-design.md)
§3.1, §3.2, §3.5; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
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
   - Запис файлів метаданих увімкнено за замовчуванням у CLI й MCP: файли в
     git, запис лише після чистої компіляції результату й лише в межах теки
     (`writeChanges`) — ці дві гарантії названо в спеці як причину.
     `--allow-write` прибирається; `--read-only` вимикає запис.
   - Читання бази — без окремого дозволу. Невидимі агенту захисти: сесія
     цілі read-only (`default_transaction_read_only = on`); рядок підключення
     лише із середовища, ім'я змінної фіксується при запуску
     (`--database-url-env <NAME>`, типово `SIMETRA_DATABASE_URL`), ніколи з
     входу інструмента; рядок, користувач і пароль не з'являються в жодному
     виводі, структурованому результаті, діагностиці чи помилці.
   - Тінь — окрема адміністративна сесія з правом `CREATE DATABASE`,
     co-located із ціллю (платформна спека §6.2). Опція `--shadow-url-env`
     — інший сервер тієї самої мажорної версії Postgres (перевіряється;
     розбіжність — відмова); базовий стан провайдера засівається з цілі,
     тож пресет однаковий. Тінь прибирається при нормальному завершенні й
     винятку; після сигналу — борг П3.
   - Єдине тертя рівня файлів — `delete` (`confirm`/`--yes`): втрата UUID
     переживає відкат файлів (наступний `create` видає новий UUID, і П3
     спланує видалення таблиці з даними). `introspect` у непорожню теку не
     руйнівний. `database: "write"` (`apply`, П3) — власне підтвердження з
     показаним планом.
2. **Підключення — ресурс запуску, лінивий** (`ToolContext.database`):
   інструменти з `database: "none"` не читають середовища й не відкривають
   пулів. Відсутність підключення для інструмента з базою — відмова в
   `invoke` поряд із `permits` (`"no-database"`), підказка — з того самого
   модуля, що й `readOnlyHint`. Пули відкриваються на виклик і закриваються
   в `finally`. Помилки підключення стають стабільними англійськими
   повідомленнями на одній межі (`database.ts`), до того як потрапити в
   будь-який канал виводу.
3. **Зворотний генератор — чистий T2** (`src/schema/reverse/`), вхід —
   `CatalogModel` і наявна тека, вихід — **підсумкова** мапа теки після
   злиття, зміни й діагностика; компілюється саме підсумкова мапа.
4. **Логічні імена й шляхи — унікальні на всю множину:** об'єкт —
   PascalCase фізичного імені, колонка — за `naming.attributeCase`.
   Колізія (`a_b`/`a__b`, однакове ім'я в різних схемах) розв'язується
   детерміновано: спершу префікс схеми (`AppOrders`), далі числовий суфікс
   за порядком `(schema, physicalName)`. SQL-зарезервованість логічних імен
   не стосується (спека §3). `physicalName` пишеться явно (= поточне ім'я).
5. **Тип колонки — інверсія `pgTypeOf`:** образ логічного типу → логічний
   тип з параметрами; `uuid` — завжди `UUID` (FK описується окремо, як є);
   T0 повертає для енам-типу фізичну пару, а посилання `{ kind: "PgEnum",
   name: <логічне ім'я> }` будує генератор після реєстру енамів; решта —
   `Raw`.
6. **Збереження ідентичності** — за ключами `(kind, schema, physicalName)`
   для об'єктів і `(schema, table, physicalName)` для колонок, значень
   енамів і обмежень; дублікат ключа в наявній теці — діагностика.
   Згенерований файл `CustomTable`/`PgEnum`/дослівного SQL, чийого об'єкта в
   базі вже немає, видаляється; файли видів 1С і ручні файли поза цими
   теками не чіпаються; наявний `project.meta.json` не переписується
   (розбіжність його `defaultSchema` з межею — діагностика).
7. **Розкладка SQL-одиниць** (спека §3): у `<Ім'я>.sql` таблиці — її
   тригери, політики, гранти на неї, `replicaIdentity`, `sequenceOwnedBy` її
   колонок і **тригерна функція, яку викликають лише тригери цієї
   таблиці**; порядок операторів у файлі — порядок створення (функція перед
   тригером). Решта — `sql/<схема>/<ім'я>.sql`, де ім'я файлу виводиться з
   **повної ідентичності** одиниці (перевантаження — суфікс типів
   аргументів; пари гранту, коментаря, publication × таблиця — ціль і роль у
   імені), унікальність шляхів перевіряє генератор. Схема одиниці без
   власної схеми — схема структурованої цілі (рішення 9), інакше
   `defaultSchema`.
8. **Гучна помилка** — `introspect.unrepresentable` (error) з ім'ям об'єкта:
   EXCLUDE-обмеження, таблиця без колонок, інше невиражене; разом з
   `engine.unrepresentable` extract-у `introspect` не пише нічого при хоч
   одній помилці. Нормалізація боргу F (типові опклас, колляція,
   `deferrable`) — генератор пише лише нетипові значення.
9. **Структурована ціль одиниці — одна функція для межі й діагностики:**
   `unitTarget(unit)` (схема й об'єкт цілі з дерева розбору для `grant`,
   `comment`, `policy`, `trigger`, `publication`) використовують і
   `engineScope` (керовані схеми), і `outOfScopeDiagnostics`. Поверхня
   пресету провайдера — дані в `provider/supabase.ts`.
10. **Повнота round-trip — з незалежним оракулом:** окрім `empty`, кожна
    фікстура класу підтверджує властивість у `pg_catalog` тестовим читачем
    E1 (`packages/simetra/test/db/catalog.ts`) у цілі й у тіні після
    round-trip; однакова втрата з обох боків extract-у так не пройде.
11. **Приватна звірка — два різні кроки:** (а) санітарний round-trip
    `introspect → diff` копії споживача (порожньо); (б) власне звірка §10.3 —
    вручну описані метадані найменшого документа з регістрами в репо
    споживача, `simetra diff` з фільтром таблиць документа, ТЧ і регістрів;
    очікуваний план — рівно стандартні елементи виду й заміни FK/індексів за
    §10.2 (М4).

## Global Constraints

- Ярус: генератор — T2 `packages/simetra/src/schema/reverse/`, без `pg`,
  pg-delta, диска й Node API (лінт і `test/tier-boundary.test.ts`);
  інструменти, підключення й тінь — лише `packages/designer`.
- Нових залежностей немає; наявні піни — без змін.
- Тексти діагностик — `en`/`uk`/`hint` у `MESSAGES`, коди в `COMPILER_RULES`;
  описи інструментів і повідомлення CLI/MCP — англійською.
- Рядок підключення, користувач і пароль не з'являються в тексті,
  `structuredContent`, діагностиці, stderr чи відмові — тест у задачі 5.
- Приватні дані першого споживача (дамп, метадані, виходи звірки) не
  потрапляють у git; репо публічне.
- Коміти — Conventional Commits, опис українською, без трейлерів.
- Гейти в кожній задачі: scoped-тести, typecheck, lint, `pnpm format:check`;
  задачі 4–5 — ще `pnpm --filter @simetra/designer test:db`; перед
  фінальним рев'ю — повні кореневі гейти, `pnpm metadata:check`,
  `pnpm test:db`; після правок документів — `python3 scripts/check-doc-anchors.py`.

## Review Focus

1. **Round-trip не губить властивостей** — для кожного класу спеки §9
   властивість видно в `pg_catalog` цілі й тіні після round-trip, не лише
   `empty`. Задача 4.
2. **Невиражене не стає тишею** — EXCLUDE чи власник-не-сесія дає помилку, і
   `introspect` нічого не пише. Задачі 3 і 5.
3. **Облікові дані не витікають** — недосяжний хост і хибний пароль дають
   повідомлення без URL, користувача й пароля в усіх каналах. Задача 5.
4. **Повторний `introspect` ідемпотентний** — id зберігаються за ключами
   рішення 6, другий прогін — нуль змін; дві таблиці `orders` у різних
   схемах і колонки `id` в багатьох таблицях не зливаються. Задачі 3 і 5.
5. **Грант на таблицю в схемі, де немає інших об'єктів моделі,** потрапляє
   в межу, а GRANT/COMMENT на таблиці провайдера — `engine.out-of-scope`.
   Задача 0.

---

### Task 0: Структурована ціль одиниці, поверхня пресету, борги E2a

**Files:**
- Create: `packages/simetra/src/schema/engine/unit-target.ts`
- Modify: `engine/provider/supabase.ts`, `engine/desired.ts` (`engineScope`, `outOfScopeDiagnostics`), `packages/simetra/src/compiler/messages.ts` (`OUT_OF_SCOPE_REASONS` — після `MESSAGES`, не між JSDoc і ним), `engine/port.ts` (JSDoc `withDesiredShadow` про фільтр `unmodeled_kind`)
- Test: `packages/simetra/src/schema/__tests__/unit-target.test.ts`, `out-of-scope.test.ts`; контрактний — `packages/designer/src/schema-engine/__tests__/engine-policy.test.ts`

**Interfaces:**
- Produces (`simetra/schema`):
  ```ts
  interface UnitTarget { schema: string; object?: string; kind?: "table" | "schema" | "function" | "publication" | "other" }
  function unitTarget(unit: Pick<CatalogUnit, "class" | "schema" | "sql">, parse: SqlParser): UnitTarget | undefined
  interface ProviderSurface { schema: string; table: string /* glob */; classes: readonly ("policy" | "trigger")[] }
  const SUPABASE_SURFACES: readonly ProviderSurface[]
  const SUPABASE_ROLES: readonly string[]
  ```
  `engineScope` і `outOfScopeDiagnostics` беруть схему одиниці з
  `unitTarget`; `engineScope` стає асинхронним, якщо парсер цього вимагає
  (оновити викликачів). Правила поверхні — рішення плану 9.
- [ ] **Step 1: Тести** — `grant target schema joins the scope` (грант на
  `reports.t`, без інших об'єктів у `reports` → `reports` у межі); `grant on
  a provider table is out of scope`; `comment on auth.users is out of scope`;
  `policy on storage.migrations is out of scope`; `trigger on auth.users with
  a function in extensions is out of scope`; `policy on storage.objects is in
  scope`; `ADP IN SCHEMA app gives no diagnostic`; контрактні — `surfaces
  match the engine preset` (правило `supabase.user-policy-surface`
  закріпленої версії) і `extension list is not empty` (`toContain("pg_graphql")`).
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти обох пакетів.
- [ ] **Step 5: Commit** `fix(schema): структурована ціль одиниці для межі й діагностики, поверхня провайдера даними`

---

### Task 1: Модель дозволів — дві осі, запис за замовчуванням, підключення як ресурс

**Files:**
- Create: `packages/designer/src/tools/hints.ts` (`readOnlyHint`, `noDatabaseHint`; замінює `write-access.ts`)
- Modify: `packages/designer/src/tools/types.ts`, `tools/invoke.ts`, `tools/read.ts`, `tools/mutations.ts`, `src/cli/command.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/commands/mcp.ts`
- Modify: спека designer §3.1, §3.2, §3.5; спека П2 §8.6; `docs/architecture/designer.md`; скіл `packages/designer/skills/simetra-metadata/SKILL.md`
- Test: `packages/designer/src/__tests__/catalog.test.ts`, `mcp.test.ts`, `cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type FilesAccess = "read" | "write"
  type DatabaseAccess = "none" | "read" | "write"
  interface Tool<I, D> { name: ToolName; description: string; input: I
    files: FilesAccess; database: DatabaseAccess; destructive: boolean
    run(ctx: ToolContext, input: z.infer<I>): Promise<RunOutcome<D>> }
  interface DatabaseResource { describe: string /* host:port/db, без користувача */; connect(): Promise<DatabaseContext> }
  interface ToolContext { dir: string; database?: DatabaseResource }
  interface InvokeOptions { dir: string; readOnly: boolean; dryRun: boolean; confirmed: boolean
    database?: DatabaseResource; launchArgs?: readonly string[] }
  type RefusalReason = "invalid-input" | "read-only" | "no-database" | "unconfirmed" | "refused"
  function permits(tool: Tool, o: { readOnly: boolean }): boolean          // вичерпний switch по обох осях
  const READ_ONLY_FLAG = "--read-only"
  function readOnlyHint(launchArgs?: readonly string[]): string
  function noDatabaseHint(envName: string): string
  ```
  Порядок `invoke`: вхід → `permits` → `database !== "none" && !o.database`
  → `"no-database"` → підтвердження → черга → `run` → запис. `DatabaseContext`
  визначає задача 5; тут — лише тип-ресурс і відмова. Описи інструментів
  більше не згадують `--allow-write`.
- [ ] **Step 1: Тести** — `every (files, database) pair in TOOLS has a permit
  rule`; `writes are on by default in mcp and cli`; `--read-only refuses a
  write and names the flag`; `a database tool without a connection is
  refused with the env hint` (на тестовому інструменті-заглушці);
  `delete still needs confirm`; `tools/list does not change with
  --read-only`; `no description mentions --allow-write`.
- [ ] **Step 2–4:** червоні → реалізація (без шиму `--allow-write`) →
  зелені, гейти.
- [ ] **Step 5:** правки спек (designer §3.5 «MCP з правом запису за
  замовчуванням» прибрати; §3.1–§3.2 — осі, `--read-only`, підключення з
  середовища, тінь; П2 §8.6 — правило рішення плану 1), карти й скіла;
  `check-doc-anchors.py`. **Текст правок спеки designer до виконання
  переглядає архітектор designer** (`simetra-designer-spec`).
- [ ] **Step 6: Commit** `feat(designer): дві осі дозволів, запис за замовчуванням, --read-only, підключення як ресурс запуску`

---

### Task 2: Інверсії T0 — логічне ім'я й логічний тип із фізичних

**Files:**
- Modify: `packages/simetra/src/model/schemas/identity.ts`, `src/model/physical/pg-types.ts`, `src/model/index.ts`
- Test: `packages/simetra/src/model/__tests__/identity-inverse.test.ts`, `pg-types-inverse.test.ts`

**Interfaces:**
- Produces (`simetra/model`):
  ```ts
  function logicalObjectName(physical: string): string                       // snake → PascalCase (без розв'язання колізій — задача 3)
  function logicalElementName(physical: string, style: AttributeCase): string
  type ColumnTypeForm =
    | { form: "logical"; value: ValueType }                                  // ValueType — вхід pgTypeOf
    | { form: "enum"; schema: string; name: string }                         // фізична пара; посилання будує генератор
    | { form: "raw"; pgType: string }
  function logicalTypeOf(formatType: string, enumTypes: ReadonlySet<string> /* "schema.name" */): ColumnTypeForm
  ```
  Правило — рішення плану 5.
- [ ] **Step 1: Тести** — `snake to Pascal` (`service_accrual` →
  `ServiceAccrual`); `snake to camel` і `snake stays snake`; `inverse of
  pgTypeOf is exact` (для кожного логічного типу й параметрів, лише для
  форми `logical`: `pgTypeOf(logicalTypeOf(pgTypeOf(v)).value) === pgTypeOf(v)`);
  `uuid is UUID`; `unknown type is raw` (`timestamp without time zone`,
  `citext`, `json`); `enum in scope is the physical pair`; `numeric without
  scale`.
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(model): логічні імена й типи з фізичних — інверсії для зворотної генерації`

---

### Task 3: Зворотний генератор (T2, чистий)

**Files:**
- Create: `packages/simetra/src/schema/reverse/generate.ts`, `reverse/names.ts`, `reverse/tables.ts`, `reverse/units.ts`, `reverse/identity.ts`, `reverse/index.ts`
- Modify: `packages/simetra/src/schema/index.ts`, `compiler/diagnostics.ts`, `messages.ts` (`introspect.unrepresentable`, `introspect.identity-conflict`, `introspect.project-mismatch`, `introspect.path-collision`)
- Test: `packages/simetra/src/schema/__tests__/reverse-generate.test.ts` (юніт над `CatalogModel`-літералами)

**Interfaces:**
- Consumes: `CatalogModel`; задача 2; `unitTarget` (задача 0); `completeFiles` (`compiler/operations/fix.ts`), `formatMetaFile`, `formatProjectFile`, `compile`, `SqlParser`.
- Produces (`simetra/schema`):
  ```ts
  interface ReverseOptions {
    project: { name: string; defaultSchema: string; attributeCase: AttributeCase }   // лише для нової теки
    existing: ReadonlyMap<string, string>
    newId: IdSource; schemaPath: SchemaPathResolver; parse: SqlParser
  }
  interface ReverseResult { files: Map<string, string> /* підсумкова тека */; changes: FileChange[]; diagnostics: Diagnostic[] }
  function reverseGenerate(model: CatalogModel, o: ReverseOptions): Promise<ReverseResult>
  ```
  Рішення плану 3–8. Нова тека → повний `project.meta.json`
  (`formatProjectFile`) з `name`, `defaultSchema`, `naming.attributeCase`.
  `diagnostics` = помилки генератора + компіляція підсумкової мапи; при
  помилці `changes` порожні.
- [ ] **Step 1: Тести** — `table becomes a CustomTable with explicit names`;
  `fk to a managed table uses an object ref, to auth.users external`; `enum
  column references the PgEnum by logical name` (проходить Zod-схему й
  компіляцію); `trigger function used by one table goes to its sidecar before
  the trigger`; `shared function goes to sql/<schema>/<name>__<args>.sql`;
  `two grants on one object get distinct paths`; `orders in two schemas get
  distinct names` (`AppOrders`, `ReportsOrders`); `existing ids are kept by
  (kind, schema, physicalName)`; `id columns in many tables keep their own
  ids`; `stale generated file is deleted, a 1C kind file is kept`;
  `existing project file is not rewritten`; `default opclass, collation and
  deferrable are omitted`; `exclude constraint and a table without columns
  are unrepresentable`; `final map compiles`.
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(schema): зворотний генератор — модель каталогу в CustomTable, PgEnum і дослівний SQL`

---

### Task 4: Повний round-trip з незалежним оракулом

**Files:**
- Create: `packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts`, `__tests__/fixtures/round-trip-classes.ts`
- Modify: `packages/simetra/test/support.ts` (реекспорт `readCatalog` з `test/db/catalog.ts`), спека П2 §9 (інваріанти зворотної генерації: `uuid` → `UUID`, розкладка одиниць, ключі ідентичності), `docs/architecture/metadata-pipeline.md`

- [ ] **Step 1: Тести.** Помічник `roundTrip(sql)`: ціль — тінь із SQL
  фікстури → `extract` → `reverseGenerate` (порожня тека) → компіляція `ok`
  → `renderDesiredState` → `compareWithDesired` → `empty`, **і**
  `readCatalog` цілі та тіні дає ту саму форму властивості класу. Корпус:
  - класи спеки §9 (Review Focus 1), кожен окремою фікстурою з твердженням
    у `pg_catalog`: виразний і частковий індекс, `NULLS NOT DISTINCT`,
    таблиця без PK, identity `ALWAYS`, FK на `auth.users`; плюс енам-тип,
    тригер із функцією, політика, грант, коментар, `OWNED BY`, `REPLICA
    IDENTITY FULL`, ADP, дві таблиці з однаковим ім'ям у різних схемах;
  - корпус E1 (`FIXTURES`) і синтетичний домен (види 1С повертаються як
    `CustomTable` з тими самими фізичними іменами);
  - гучні (Review Focus 2): EXCLUDE → `engine.unrepresentable`/
    `introspect.unrepresentable` з ім'ям; власник-не-сесія →
    `engine.unrepresentable`; cast → `engine.unmodeled-class`.
- [ ] **Step 2:** `pnpm --filter @simetra/designer test:db round-trip` —
  зелено; час db-проєкту в звіті.
- [ ] **Step 3:** правки спеки §9 і карти; `check-doc-anchors.py`.
- [ ] **Step 4: Commit** `test(designer): повний round-trip з незалежним оракулом на фікстурах класів і корпусі`

---

### Task 5: Інструменти `introspect` і `diff`

**Files:**
- Create: `packages/designer/src/tools/database-tools.ts`, `packages/designer/src/io/database.ts`
- Modify: `tools/types.ts` (`TOOL_NAMES`), `tools/catalog.ts`, `src/cli/command.ts`, `src/cli/input.ts`, `src/cli/render.ts`, `src/mcp/tools.ts` (`toResponse`), `src/commands/mcp.ts` (`--database-url-env`, `--shadow-url-env`), `packages/designer/src/schema-engine/pg-delta/adapter.ts` (read-only сесія цілі, адміністративна сесія тіні), `packages/simetra/src/schema/engine/port.ts` і `engine/desired.ts`
- Modify: спека П2 §8.6–§8.7, `docs/architecture/designer.md`, скіл `simetra-metadata` (приклади `introspect`/`diff`; «1 = відмінності чи помилки»)
- Test: `packages/designer/src/__tests__/database-tools.db.test.ts`, `database-errors.test.ts`; бюджет `tools/list` у `mcp.test.ts`; `skill-examples.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // simetra/schema — порт:
  interface ShadowOptions { target: DbConnection; shadowBase?: DbConnection }   // без shadowBase — co-located
  withDesiredShadow<T>(o: ShadowOptions, desiredSql: string, scope: EngineScope, fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>): Promise<ShadowOutcome<T>>
  compareWithDesired(engine: SchemaEngine, o: ShadowOptions, desiredSql: string, scope: EngineScope, scopeDiagnostics: readonly EngineDiagnostic[]): Promise<DesiredComparison>
  // designer io/database.ts:
  interface DatabaseContext { target: DbConnection; shadowBase?: DbConnection; describe: string }
  function databaseResource(env: NodeJS.ProcessEnv, names: { url: string; shadow?: string }): DatabaseResource | undefined
  function connectionErrorMessage(error: unknown, describe: string): string   // стабільний англійський текст без URL/користувача/пароля
  // інструменти:
  // introspect — files: "write", database: "read"; вхід { schemas?: string[]; project?: { name; attributeCase } }
  // diff       — files: "read",  database: "read"; вхід { tables?: string[] }   // фільтр таблиць для звірки §10.3
  ```
  `introspect`: межа = `engineScope` наявної теки (ті самі схеми, що в
  `diff`); без `project.meta.json` — `schemas` обов'язкові, інакше відмова
  з підказкою; extract (read-only сесія) → `reverseGenerate` → запис лише
  без помилок. `diff`: компіляція теки → рендер → `compareWithDesired` →
  `data: { plan, differences, diagnostics, empty }`, фільтр `tables` звужує
  дії й відмінності до названих таблиць. Будь-який виняток підключення
  перетворює `connectionErrorMessage` на межі інструмента. CLI:
  `simetra introspect [dir]`, `simetra diff [dir]` (+ `--schemas a,b` /
  `--tables a,b` — представлення входу з тестом відображення;
  `--database-url-env`, `--shadow-url-env`, `--format`); коди: 0 — порожньо
  / записано, 1 — відмінності чи помилки, 2 — немає підключення, недосяжна
  база, помилка використання. MCP: `structuredContent` `diff` і
  `introspect` несе дані повністю (план, відмінності, зміни), текст —
  зведення.
- [ ] **Step 1: Тести** — `introspect writes metadata that compiles`;
  `introspect twice changes nothing` (Review Focus 4); `introspect with
  errors writes nothing`; `introspect into a fresh dir without schemas is
  refused`; `diff of an introspected database is empty`; `diff names a
  dropped index in cli and mcp structured output`; `diff tables filter`;
  `target session is read-only` (`CREATE TABLE` через пул цілі падає);
  `shadow session is not read-only`; `shadow on another server with another
  major version is refused`; `bad password and unreachable host are
  redacted in text, structuredContent and stderr` (Review Focus 3);
  `no pool is left open after a refused or failed call`; `no shadow is left
  behind`; приклади скіла з `introspect`/`diff` розбираються; перемір
  бюджету `tools/list` — свідомий, коментар «перевиміряно в E2b: <число>».
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти, `test:db`.
- [ ] **Step 5: Commit** `feat(designer): інструменти introspect і diff над портом SchemaEngine`

---

### Task 6: Процедура приватної звірки, канон, ROADMAP

**Files:**
- Create: `.agents/skills/consumer-reconciliation/SKILL.md` (+ симлінк `.claude/skills/consumer-reconciliation`), запис у skill mappings `AGENTS.md`
- Modify: спека П2 §10.3 (команди звірки), `docs/ROADMAP.md`

- [ ] **Step 1:** процедура приватної звірки (рішення плану 11). Що й
  навіщо — спека П2 §10.3, заборона публічного репо — `AGENTS.md`
  «Platform / consumer boundary»; тут лише кроки:
  1. schema-only дамп від власника — в **окрему** базу локального стеку,
     ніколи в базу тестів; стек — лише через `pnpm db:*`.
  2. Санітарний round-trip: підключення лише зі змінної оточення;
     `simetra introspect <тека поза репо> --schemas … --dry-run`, потім без
     `--dry-run` (невиражене — діагностика: звітувати, не обходити) →
     `simetra diff <та сама тека>` → порожньо.
  3. Метадані найменшого документа з регістрами — вручну в репо споживача;
     `simetra diff <тека> --tables <таблиці документа, ТЧ, регістрів>`.
     Діагностики фільтр не звужує, тож код виходу 1 буває й через незв'язані
     об'єкти — судити за планом і відмінностями.
  4. План оцінюється за §10.2 і М4 (лише стандартні елементи виду й заміни
     FK/індексів на складені за скоупом); решта — знахідка, відхилення
     платформи — до власника.
  5. Виходи (метадані, плани, логи) — поза цим репо; у звіті — клас
     розбіжності, не імена.
- [ ] **Step 2:** ROADMAP: план E2b у рядку П2, «Зараз» — E2b виконано,
  далі приватна звірка (дамп від власника) і П3.
- [ ] **Step 3:** повні кореневі гейти, `pnpm metadata:check`, `pnpm test:db`.
- [ ] **Step 4: Commit** `docs(skill): процедура приватної звірки першого споживача; канон E2b`

---

## Поза E2b

- Прогін приватної звірки на дампі MetaHub — після E2b, з дампом від
  власника; виходи поза репо.
- Форма EXCLUDE-обмежень у моделі — рішення власника.
- Машинна класифікація плану за §10.2/М4 (класифікатор «стандартний елемент
  виду / заміна за скоупом») — разом із планувальником намірів П3; у E2b
  план звірки оцінюється за процедурою Task 6.
- Прибирання тіней-сиріт після сигналу — П3. Час db-проєкту — борг E2a.

## Критерії приймання плану E2b

- Повний round-trip порожній і підтверджений оракулом `pg_catalog` на
  фікстурах класів спеки §9, корпусі E1 і синтетичному домені; невиражене —
  гучна помилка.
- `simetra introspect`/`simetra diff` працюють у CLI й MCP, сесія цілі
  read-only, облікові дані не витікають жодним каналом, пули й тіні не
  лишаються.
- Модель дозволів: запис файлів за замовчуванням, `--read-only`, `delete` з
  підтвердженням, осі вичерпні; спеки designer і П2 узгоджені.
- Межа керування бере ціль одиниць структуровано; тиха порожнеча E2a
  закрита.
