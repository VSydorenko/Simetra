# П2, план E1 — рендер DDL і розгортання в Postgres: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** уперше довести справжнім Postgres, що скомпільована модель
розгортається: рендер бажаного стану (T2) з фізичного знімка й SQL-одиниць,
розгортання в локальний стек Supabase (Postgres 17) і звірка каталогу зі
знімком; синтетичний домен у `examples/reference/metadata/` і паперовий тест
на ньому.

**Архітектура:** `renderDesiredState(model)` — чиста функція ярусу T2
`schema` над `CompiledModel` (T1), без бази. DB-тести — окремий проєкт Vitest
(`*.db.test.ts`), що запускається лише в `pnpm test:db` проти локального стеку
й падає без бази. Тінь у E1 — **транзакційна**: усе розгортання йде в одній
транзакції в базі стеку (де вже є `auth`, `storage` і ролі провайдера) і
відкочується (`ROLLBACK`); DDL у Postgres транзакційний, тож тест ізольований
і не лишає слідів. Окремі тіньові бази й pg-delta — E2.

**Технології:** TypeScript 7, Vitest 5 (projects), `pg` **8.23.1** (MIT,
devDependency лише для тестів), локальний стек Supabase CLI 2.118.0.

**Спеки:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) §8.3
(рендер), §9 (тінь), §10 (синтетичний домен, паперовий тест, середовище);
[«Платформа в Postgres»](../specs/2026-10-01-platform-in-postgres-design.md)
§4–§6 (фізика, яку рендер мусить відтворити).

**Передумова:** план F приземлено (предвизначені з міткою, повнота
`CustomTable`, індекс посилань). Перед стартом — `orient --plan` цього файлу.

**Серія:** F → **E1** (цей) → D2 (CLI, MCP, pre-commit) → E2 (порт
`SchemaEngine` з pg-delta, окремі тіні, зворотна генерація, round-trip,
приватна звірка).

## Рішення плану

1. **Рендер у E1 охоплює** (спека §8.3): схеми, енам-типи, таблиці з
   колонками (типи у формі `format_type()`, `NOT NULL`, `DEFAULT`, identity,
   генеровані `STORED`, колляції), PK/UNIQUE/CHECK (з `NULLS NOT DISTINCT`,
   `deferrable`), індекси (часткові, виразні, `INCLUDE`, порядок, opclass),
   FK — окремим `ALTER TABLE … ADD CONSTRAINT` **після всіх таблиць** (спека
   §8.3), `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` за
   `rowLevelSecurity`, коментарі, дослівні SQL-одиниці й обгортки запитів
   рухів у `creationOrder`. **Не рендерить** (П3): тригери платформи
   (версія, підсумки, незмінність, нумерація), RLS-політики, гранти платформи,
   оболонку проведення, віртуальні таблиці, функції пошуку предвизначених.
2. **Тінь E1 — транзакція з відкатом** у базі локального стеку. Базовий стан
   провайдера (`auth.users`, ролі) — уже там (спека §10.4). Об'єкти домену
   живуть у власних схемах (`app` для домену, `accepted` для «прийнятої»
   форми паперового тесту), тож не перетинаються з `public` стеку.
3. **Звірка каталогу в E1** — тестовий читач `pg_catalog` (лише в тестах,
   не в API: власна інтроспекція в продукті заборонена спекою §9). Порівняння
   «база ↔ база» двигуном — E2.
4. **Канонічна форма файлів домену** належить форматеру T0, тож
   `examples/**/metadata/**` — у `.prettierignore`; тест гарантує, що кожен
   файл дорівнює `formatMetaFile` від себе.

## Global Constraints

- T2 імпортує T1 і T0, не навпаки (лінт-зони). `renderDesiredState` — чиста
  й детермінована: той самий знімок → побайтно той самий SQL.
- Ідентифікатори — `quoteIdent`; літерали — екранування `'`; жодного
  конкатенування сирих імен.
- `pg` — лише `devDependencies` пакета `simetra`, лише в `*.db.test.ts`.
- DB-тест без бази — **червоний**, не пропуск (спека §10.4).
- Синтетичний домен — без споживацьких імен і даних (репо публічне).
- Коміти — Conventional Commits, опис українською, без трейлерів.
- Гейти: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, плюс
  `pnpm db:start && pnpm test:db` для задач 1, 4–6;
  після правки доків — `python3 scripts/check-doc-anchors.py`.

## Review Focus

1. **Вираз генерованої колонки `number_period`** (`date_trunc(… AT TIME ZONE …)::date`)
   Postgres приймає як `GENERATED ALWAYS AS … STORED` (вимога IMMUTABLE).
   Тест — задача 4.
2. **FK до таблиці, створеної пізніше в порядку**, і FK на `auth.users` —
   розгортаються, бо FK рендеряться після всіх таблиць. Тест — задача 4.
3. **`UNIQUE NULLS NOT DISTINCT`** реально відкидає другий рядок із `NULL` у
   вимірі. Тест — задача 4.
4. **Обгортка запиту рухів** створюється (`LANGUAGE sql` перевіряє тіло при
   створенні — отже таблиці й колонки, на які посилається запит, справжні).
   Тест — задача 4.
5. **Порядок вставки файлів у мапу** не змінює SQL рендера. Тест — задача 2.

---

### Task 0: Хвости F, що зачіпають рендер

**Files:**
- Modify: `packages/simetra/src/compiler/stages/identity.ts`, `compiler/stages/integrity.ts` (або місце перевірки поясу), `compiler/compile.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-identity.test.ts`, `value-checks.test.ts`

**Interfaces:**
- Produces:
  - Мітки значень перерахування унікальні в межах перерахування
    (`identity.name-duplicate` на `/values/<i>/physicalName`): дві однакові
    мітки дали б `CHECK (… IN ('a','a'))` і нерозрізненні значення в даних.
  - Часовий пояс проєкту нормалізується до канонічного написання IANA
    (`Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone`)
    у скомпільованій моделі: рендер підставляє в генеровані колонки одне
    написання, а хеш не залежить від регістру в файлі.
- Борги F, що лишаються поза E1: `scopeColumn` на стадії 4 за іменем — D2
  (каскад перейменування); друга форма знімка при явному типовому
  opclass/колляції й асиметрія `deferrable` — E2 (round-trip).

- [x] **Step 1: Тести** — `enumeration labels are unique`; `time zone is
  canonicalised` (`"europe/kyiv"` → `"Europe/Kyiv"` у моделі й однаковий хеш).
- [x] **Step 2: Червоні** — `pnpm --filter simetra test stage-identity value-checks` → FAIL.
- [x] **Step 3: Реалізація.**
- [x] **Step 4: Зелені** — PASS; повні гейти.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "fix(compiler): унікальні мітки значень перерахування, канонічний часовий пояс проєкту"
```

---

### Task 1: Інфраструктура DB-тестів

**Files:**
- Modify: `packages/simetra/package.json` (`devDependencies.pg: "8.23.1"`, `@types/pg`; скрипт `"test:db": "vitest run --project db"`, `"test": "vitest run --project unit"`), `packages/simetra/vitest.config.ts` (projects `unit` — без `**/*.db.test.ts`; `db` — лише `**/*.db.test.ts`, `fileParallelism: false`), кореневий `package.json` (`"test:db": "supabase test db && pnpm --filter simetra test:db"`)
- Create: `packages/simetra/test/db/connection.ts`, `test/db/catalog.ts`
- Test: `packages/simetra/test/db/stack.db.test.ts`
- Modify: `AGENTS.md` § «Commands and gates» (рядок `pnpm test:db` — pgTAP і DB-тести Vitest)

**Interfaces:**
- Produces (лише для тестів):
  - `withRollback<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>` —
    з'єднання з `process.env.SIMETRA_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres"`,
    `BEGIN` → `fn` → `ROLLBACK` завжди; відсутність бази — виняток (тест
    червоний).
  - `readCatalog(client, schemas: string[]): Promise<CatalogShape>` —
    таблиці, колонки (`format_type`, `attnotnull`, `pg_get_expr` default,
    `attidentity`, `attgenerated` + вираз, колляція), обмеження
    (`pg_get_constraintdef`, `condeferrable`), індекси (`pg_get_indexdef`),
    енам-типи з порядком, коментарі, `relrowsecurity`/`relforcerowsecurity`,
    функції (`proname`, аргументи); усе відсортоване; схема в дефініціях
    нормалізується до плейсхолдера `<schema>`, щоб дві схеми порівнювались.

- [x] **Step 1: Тест** `stack.db.test.ts`: `rollback leaves no trace`
  (`CREATE SCHEMA e1_probe` у `withRollback`, після — схеми немає);
  `provider base state is visible` (`auth.users` існує); `readCatalog reads a
  table` (таблиця з PK, `NULLS NOT DISTINCT` UNIQUE і генерованою колонкою →
  очікувана форма).
- [x] **Step 2: Без стеку** — `pnpm --filter simetra test:db` → FAIL
  (з'єднання). **Зі стеком** — `pnpm db:start && pnpm --filter simetra test:db` → PASS.
- [x] **Step 3:** `pnpm test` (юніти) не запускає `*.db.test.ts`; CI-джоба
  `db` запускає обидва набори (кореневий `test:db`).
- [x] **Step 4: Commit**

```bash
git add packages/simetra package.json pnpm-lock.yaml AGENTS.md
git commit -m "test(schema): інфраструктура DB-тестів Vitest проти локального стеку з транзакцією-відкатом"
```

---

### Task 2: Рендер таблиць, типів, обмежень, індексів (T2)

**Files:**
- Create: `packages/simetra/src/schema/render/statements.ts`, `render/index.ts`
- Modify: `packages/simetra/src/schema/index.ts`
- Test: `packages/simetra/src/schema/__tests__/render-tables.test.ts`

**Interfaces:**
- Produces (експорт з `simetra/schema`):
  ```ts
  interface RenderedStatement {
    kind: "schema" | "enumType" | "table" | "foreignKey" | "index" | "rowLevelSecurity" | "comment" | "unit"
    object: string        // schema.name об'єкта, для діагностики й тестів
    sql: string           // один оператор із завершальною `;`
  }
  function renderTable(table: PhysicalTable): RenderedStatement[]           // CREATE TABLE з колонками, PK, UNIQUE, CHECK; без FK
  function renderIndexes(table: PhysicalTable): RenderedStatement[]
  function renderForeignKeys(table: PhysicalTable): RenderedStatement[]    // ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY
  function renderEnumType(type: PhysicalEnumType): RenderedStatement
  function renderRowLevelSecurity(table: PhysicalTable): RenderedStatement[]
  function renderComments(table: PhysicalTable): RenderedStatement[]
  ```
  Форми: колонка — `"<name>" <type> [COLLATE "<c>"] [GENERATED ALWAYS AS IDENTITY | GENERATED BY DEFAULT AS IDENTITY | GENERATED ALWAYS AS (<expr>) STORED] [DEFAULT <expr>] [NOT NULL]`;
  `CONSTRAINT "<name>" PRIMARY KEY (…) [DEFERRABLE [INITIALLY DEFERRED]]`;
  `CONSTRAINT "<name>" UNIQUE [NULLS NOT DISTINCT] (…)`; `CONSTRAINT "<name>" CHECK (<expr>)`;
  `CREATE [UNIQUE] INDEX "<name>" ON <schema>.<table> USING <method> (<key> [COLLATE] [<opclass>] [ASC|DESC] [NULLS FIRST|LAST], …) [INCLUDE (…)] [NULLS NOT DISTINCT] [WHERE <pred>]`;
  FK — `ALTER TABLE … ADD CONSTRAINT "<name>" FOREIGN KEY (…) REFERENCES <schema>.<table> (…) ON DELETE <a> ON UPDATE <a> [DEFERRABLE …]`;
  імена й схеми — `quoteIdent`.

- [x] **Step 1: Тести** (`toMatchInlineSnapshot`): `catalog table`;
  `generated number period column`; `unique nulls not distinct and deferrable`;
  `partial and expression index with order and opclass`; `foreign key with
  actions`; `enum type keeps value order`; `rls enabled and forced`;
  `comments`; `identifiers are quoted` (ім'я колонки `order`); `deterministic`.
- [x] **Step 2: Червоні** — `pnpm --filter simetra test render-tables` → FAIL.
- [x] **Step 3: Реалізація.**
- [x] **Step 4: Зелені** — PASS; повні гейти.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src/schema
git commit -m "feat(schema): рендер таблиць, енам-типів, обмежень, індексів і FK з фізичного знімка"
```

---

### Task 3: Бажаний стан цілком — порядок, SQL-одиниці, обгортки рухів

**Files:**
- Create: `packages/simetra/src/schema/render/desired-state.ts`
- Test: `packages/simetra/src/schema/__tests__/desired-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface DesiredState { statements: RenderedStatement[]; sql: string }   // sql — оператори через "\n\n"
  function renderDesiredState(model: CompiledModel): DesiredState
  ```
  Порядок: (1) `CREATE SCHEMA IF NOT EXISTS` для кожної схеми таблиць,
  енам-типів і одиниць моделі (крім `public` і схем провайдера: `auth`,
  `storage`, `realtime`, `extensions`); (2) вузли `model.creationOrder`
  по черзі: енам-тип, таблиця (`renderTable` + `renderIndexes` +
  `renderRowLevelSecurity` + `renderComments`), одиниця (`unit.sql`); (3) усі
  FK (`renderForeignKeys`) у порядку таблиць. Обгортки запитів рухів — одиниці
  класу `movementQuery` у тому самому порядку.

- [x] **Step 1: Тести** — `schemas first, then creation order, then foreign
  keys`; `extension unit before tables`; `movement wrapper after its
  tables`; `provider schemas are not created`; `map insertion order does not
  change the sql`.
- [x] **Step 2: Червоні** — `pnpm --filter simetra test desired-state` → FAIL.
- [x] **Step 3: Реалізація.**
- [x] **Step 4: Зелені** — PASS; повні гейти.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src/schema
git commit -m "feat(schema): бажаний стан — схеми, порядок створення, SQL-одиниці й FK наприкінці"
```

---

### Task 4: Розгортання в Postgres і звірка каталогу зі знімком

**Files:**
- Create: `packages/simetra/src/schema/__tests__/deploy.db.test.ts`, `packages/simetra/test/db/compare.ts`

**Interfaces:**
- Produces (тести): `expectCatalogMatchesSnapshot(catalog: CatalogShape, physical: PhysicalSnapshot): void`
  — для кожної таблиці знімка: є в каталозі; колонки в тому самому порядку з
  тим самим `format_type`, `notNull`, наявністю й видом default/identity/
  generated, колляцією; PK, UNIQUE (з `NULLS NOT DISTINCT`), CHECK, FK (колонки,
  ціль, дії), індекси (ім'я, унікальність, колонки/вирази, предикат) за
  іменами; RLS-позначки; енам-типи з порядком значень. Порівнюються імена й
  структура; тексти виразів — через `pg_get_expr`/`pg_get_constraintdef` лише
  на наявність (канонічну форму дає Postgres, спека §9).

- [x] **Step 1: Тести** — для кожної фікстури: compile → `renderDesiredState`
  → виконати `sql` у `withRollback` → `readCatalog` → `expectCatalogMatchesSnapshot`.
  Фікстури (через наявні хелпери тестів компілятора, схема проєкту `app`):
  - `scoped catalog with hierarchy, owner, code numbering and predefined items`;
  - `document with two tabular sections, number_period and required check`;
  - `balance and turnover accumulation registers with turnovers_month and totals`;
  - `independent and subordinate information registers with nullable dimensions`;
  - `scoped and global constants`;
  - `custom table with composite key, FK to auth.users, partial expression index, generated column, deferrable unique`;
  - `enumeration reference with check and pg enum column`;
  - `movement query wrapper and a scope set function unit`.
  Окремі поведінкові перевірки в тій самій транзакції:
  - `nulls not distinct rejects a second row with null dimension` — дві
    вставки в `turnovers_month` з `NULL` у вимірі → друга порушує ключ;
  - `number_period is generated in the project time zone` — вставка документа
    з `date = '2026-01-31 23:30:00+00'` у проєкті `Europe/Kyiv` → `number_period = '2026-02-01'`;
  - `movement wrapper returns rows` — вставка документа й рядків ТЧ → виклик
    обгортки повертає очікувані рухи.
- [x] **Step 2:** `pnpm db:start && pnpm --filter simetra test:db` — PASS.
  **Кожен збій Postgres — дефект компілятора чи рендера**: виправити в
  тому шарі (T1 — фізика, T2 — форма SQL) з юніт-тестом на причину; якщо
  виправлення змінює модель чи спеку — зупинитись і повідомити архітектора.
- [x] **Step 3: Commit**

```bash
git add packages/simetra
git commit -m "test(schema): розгортання бажаного стану в Postgres і звірка каталогу зі знімком"
```

---

### Task 5: Синтетичний домен

**Files:**
- Create: `examples/reference/metadata/` — `project.meta.json` (проєкт `Reference`, `defaultSchema: "app"`, `naming.attributeCase: "camelCase"`, `timezone: "Europe/Kyiv"`, види скоупу `org` — корінь `Organization`, і `user` — зовнішній корінь `auth.users(id)`) і об'єкти за спекою §10.1:
  `catalogs/Organization` (корінь `org`), `custom-tables/OrgMember` (складений PK `(org_id, user_id)`, FK на `auth.users`; функція множини `org` у `sql/app/accessible_org_ids.sql`), `catalogs/Currency` (`scope: "none"`, предвизначені `Uah`, `Usd`), `catalogs/Counterparty` (ієрархічний, `org`), `catalogs/Contract` (власник `Counterparty`, реквізит-посилання на `Currency`), `custom-tables/UserSettings` (скоуп `user`, явний `scopeColumn`; функція множини `user` у `sql/app/accessible_user_ids.sql`), `documents/ServiceAccrual` (дві ТЧ `Services`, `Performers`; `registerMovements` обох регістрів накопичення; рухи `PerformerSettlements` — блоком запиту в `ServiceAccrual.sql`, `IncomeExpenses` — конструктором), `accumulation-registers/PerformerSettlements` (залишків, `balanceControl`), `accumulation-registers/IncomeExpenses` (оборотний), `information-registers/Rates` (періодичний, `Month`), `enumerations/AccrualKind`, `constants/DefaultCurrency` (`Ref` на `Currency`)
- Modify: `.prettierignore` (`examples/**/metadata/**`)
- Create: `packages/simetra/src/schema/__tests__/reference-domain.test.ts`, `reference-domain.db.test.ts`

Назви — українські `title`, логічні імена — узагальнені англійські; UUID —
фіксовані v4, `physicalName` і мітки — snake_case логічних імен (до D2 їх
призначає автор; `simetra fix` з'явиться в D2).

- [x] **Step 1: Тести**
  - `reference-domain.test.ts` (юніт; читає файли через `node:fs` у тесті):
    `compiles without diagnostics` (`ok: true`, жодної діагностики, зокрема
    попереджень); `files are in canonical form` (`formatMetaFile(JSON.parse(text)) === text`
    для кожного `.meta.json`, `formatProjectFile` — для проєкту);
    `covers every kind` (у моделі є кожен вид із реєстру, крім `PgEnum` —
    його немає в домені свідомо).
  - `reference-domain.db.test.ts`: розгортання домену в `withRollback` і
    `expectCatalogMatchesSnapshot`; плюс сценарій: вставити організацію,
    члена, контрагента, договір, документ із рядками ТЧ → обгортки рухів
    обох регістрів повертають рядки з очікуваними вимірами й ресурсами.
- [x] **Step 2:** юніти й `pnpm --filter simetra test:db` — PASS (збої —
  як у задачі 4, крок 2).
- [x] **Step 3: Commit**

```bash
git add examples .prettierignore packages/simetra/src/schema/__tests__
git commit -m "feat(examples): синтетичний референсний домен і його розгортання в Postgres"
```

---

### Task 6: Паперовий тест на синтетиці

**Files:**
- Create: `examples/reference/accepted/service-accrual.sql` — рукописна «прийнята» форма в схемі `accepted`: таблиці документа `ServiceAccrual`, двох його ТЧ, рухів обох регістрів, як їх написав би застосунок без платформи (без `version`, `number_period` і `UNIQUE` номера, без складених FK скоупу й `UNIQUE (org_id, id)`, без `turnovers_month` і `totals`, без PK за реєстратором); таблиці-цілі (`Organization`, `Counterparty`, `Contract`, `Currency`) — у тій самій формі, що компілятор (вони не предмет тесту)
- Create: `examples/reference/accepted/expected-diff.json` — фікстура очікуваної різниці
- Create: `packages/simetra/test/db/diff.ts`, `packages/simetra/src/schema/__tests__/paper-test.db.test.ts`

**Interfaces:**
- Produces (тести): `diffCatalogs(accepted: CatalogShape, compiled: CatalogShape, tables: string[]): CatalogDiff`
  — лише класи, які рендерить П2 (таблиці, колонки, обмеження, індекси,
  енам-типи, коментарі; спека §10.2) і лише перелічені таблиці; кожна
  відмінність — `{ op: "add" | "drop" | "alter"; class; table; name; detail }`,
  відсортовано.
- Очікування (спека §10.2, М4): у `CatalogDiff` лише `add` відсутніх
  стандартних елементів виду (колонки `version`, `number_period`, `org_id`
  рядків ТЧ; `UNIQUE (org_id, id)`, складені FK скоупу, унікальність номера,
  PK рухів за реєстратором, індекси рухів; таблиці `*_turnovers_month`,
  `*_totals`); **жодного `drop` чи `alter`**. Фікстура `expected-diff.json` —
  точний перелік; будь-яка інша зміна валить тест.

- [x] **Step 1: Тест** — розгорнути «прийняту» форму й домен у двох схемах
  однієї транзакції-відкату, прочитати обидві, `diffCatalogs`, порівняти з
  фікстурою.
- [x] **Step 2:** `pnpm --filter simetra test:db` — PASS. Якщо різниця
  містить `drop`/`alter`, які не є стандартним елементом виду, — це
  розбіжність моделі з «прийнятою» формою: зупинитись і повідомити
  архітектора (не підганяти фікстуру).
- [x] **Step 3: Канон і статус** — спека П2 §9/§10.4: тінь E1 —
  транзакція-відкат у базі стеку, окремі тіні й pg-delta — E2 (речення, без
  переказу плану); `docs/ROADMAP.md`: посилання на план, «Зараз» — E1
  виконано, далі D2. `python3 scripts/check-doc-anchors.py`.
- [x] **Step 4: Commit**

```bash
git add examples packages/simetra docs
git commit -m "test(schema): паперовий тест синтетичного документа — різниця рівно стандартні елементи виду"
```

---

## Критерії приймання плану E1

- `renderDesiredState` дає детермінований DDL; Postgres 17 локального стеку
  приймає його для кожного виду й синтетичного домену цілком.
- Каталог після розгортання збігається з фізичним знімком.
- Генерована колонка періоду, `NULLS NOT DISTINCT`, FK після таблиць,
  обгортки рухів працюють на даних.
- Паперовий тест: різниця «прийнята ↔ скомпільована» — рівно стандартні
  елементи виду (фікстура).
- `pnpm test:db` у CI проганяє pgTAP і DB-тести Vitest; без бази — червоне.
