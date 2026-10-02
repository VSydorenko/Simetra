# П2, план E2a — порт `SchemaEngine`, адаптер pg-delta, тінь, round-trip бажаного стану: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** порівнювати живу базу з бажаним станом не тестовим читачем, а
каталожним двигуном за власним портом: extract бази в модель каталогу
Simetra, план двигуна між базою й тінню з рендером, перепис класів поза
моделлю двигуна; довести це round-trip-ом бажаного стану на корпусі
фікстур E1 і синтетичному домені.

**Архітектура:** порт `SchemaEngine` (T2 `simetra/schema`) з трьома діями —
`extract`, `plan`, `withShadow`; перший адаптер — `@supabase/pg-delta`.
Модель каталогу порту — форма фізичного знімка T0 без `origin` плюс дослівні
SQL-одиниці (спека §9); адаптер мапить у неї FactBase двигуна, розбираючи
текстові дефініції обмежень та індексів тим самим парсером libpg-query, що
й компілятор. Тінь — окрема co-located база (`CREATE DATABASE … TEMPLATE
template0`) із базовим станом провайдера. Порівняння виразів іде між двома
extract-ами (база ↔ тінь), тож канонічну форму дає Postgres.

**Технології:** TypeScript 7, Vitest 5, `@supabase/pg-delta`
**1.0.0-alpha.56** (точний пін; ліцензія в репо джерела з 2026-10-02 —
PostgreSQL License, дозволена `CONTRIBUTING.md`), `pg` 8.23.1, libpg-query
17.7.4, локальний стек Supabase (Postgres 17).

**Спека:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§9, §10.4, §8.3; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
Р6, §6.2, §6.4, §6.9; [карта перевикористання](../../research/stack/reuse-map-2026-09.md)
(рядки pg-delta, тінь).

**Передумова:** D2 приземлено. Перед стартом — `orient --plan` цього файлу.

**Серія:** D2 → **E2a** (цей) → E2b (зворотна генерація, фікстури класів,
`simetra introspect`/`simetra diff`, приватна звірка) → П3.

## Рішення плану

1. **Порт — у T2 флагманського пакета** (платформна спека §3.1:
   «порт `SchemaEngine` і його адаптер»), не окремим пакетом. `pg` і
   `@supabase/pg-delta` стають runtime-залежностями `simetra`; лінт-зони
   T2 це дозволяють, T0/T1 лишаються чистими.
2. **Модель каталогу порту — у T0** (`model/physical/catalog.ts`): типи
   `CatalogModel` = таблиці й енам-типи у формі знімка без `origin` плюс
   SQL-одиниці `{ class, identity, schema, name, sql }`. Адаптер мапить у неї
   FactBase pg-delta; FactBase назовні порту не виходить (лише як непрозорий
   `EngineCatalog` для `plan`).
3. **Текстові дефініції обмежень та індексів розбирає libpg-query**
   (`ALTER TABLE … ADD CONSTRAINT <def>`, `CREATE INDEX …`), а не регекспи й
   не власна інтроспекція `pg_catalog` (спека §9 її забороняє, крім
   доведеної прогалини). Для цього T1 експортує `loadSqlParser`/`SqlParser`.
4. **SQL-одиниці моделі каталогу** — оператори плану двигуна «порожня база →
   ця база» для об'єктів, яких модель не виражає таблицею чи енам-типом
   (функції, тригери, політики, в'юхи, гранти, типові привілеї, publication
   тощо); ідентичність кожної — той самий класифікатор, що в компіляторі
   (`readSqlUnits`), тож ідентичності бази й метаданих порівнювані.
5. **Межа керування — керовані схеми** (`EngineScope.schemas`); політика
   адаптера = `supabasePolicy` плюс фільтр «лише керовані схеми та їхні
   сателіти» (форма фільтра — з розвідки: схема, `{ kind: "schema", name }`,
   `target.schema`). Без фільтра профіль Supabase планує `DROP EXTENSION`
   і `REVOKE` у `public` — тест це закріплює.
6. **Тінь — co-located база** (`provisionCoLocatedShadow`) з базовим станом
   провайдера, відтвореним із бази-цілі (засіб двигуна для припущених схем —
   `seedAssumedSchemas`/його API); без засіву FK на `auth.users` не
   розгорнеться. Тінь прибирається завжди, зокрема при помилці.
7. **Round-trip-критерій посилено:** окрім порожнього плану двигуна
   вимагається рівність моделей каталогу бази й тіні **з порядком колонок**.
   Розвідка показала, що pg-delta не бачить порядку колонок (`_position` поза
   хешем) і стану заповнення матеріалізованого подання: тихі втрати
   закриває власна перевірка порту, а не довіра двигуну. Спека §9
   доповнюється одним реченням.
8. **Перепис класів поза моделлю:** адаптер оголошує покриті класи
   (`COVERED_CLASSES`) і перетворює діагностики двигуна `unmodeled_kind` на
   діагностику порту `engine.unmodeled-class`; матеріалізоване подання
   `WITH NO DATA` — `engine.matview-unpopulated`. Попередження двигуна
   `dangling_edge` (шум alpha на генерованих колонках) порт не пропускає
   назовні — з тестом, що доводить шум.
9. **Тестовий читач `test/db/catalog.ts` лишається тестовим оракулом** E1
   (незалежна перевірка), не стає продуктовим читачем і не видаляється в E2a.

## Global Constraints

- Ярус: порт, адаптер і тінь — `packages/simetra/src/schema/engine/`; типи
  моделі каталогу — T0 `src/model/physical/catalog.ts` (лише типи й чисті
  функції, без залежностей). Імпорти — лише вниз.
- `@supabase/pg-delta` — точна версія `1.0.0-alpha.56` без каретки (тег
  `latest` на npm — заглушка 0.0.0); перед піном — `npm view @supabase/pg-delta dist-tags`
  і `LICENSE` у тарболі (якщо нова alpha вже під PostgreSQL License — пін на
  неї дозволений; назвати версію в звіті). `pg` — точна `8.23.1`, переходить
  у `dependencies`. `reuse-map-2026-09.md` — ліцензію й версію pg-delta
  оновити.
- Перейменування двигуна вимкнені завжди (`renames: "off"`): `physicalName`
  стабільний (спека §3).
- Порт не застосовує план до бази-цілі в E2a: `apply`/`provePlan` — П3.
  Тінь — єдина база, у яку порт пише, і її завжди прибирають.
- Тексти діагностик порту — англійською з `en`/`uk`/`hint` у `MESSAGES`;
  коди — у `COMPILER_RULES` (простір `engine.*`).
- DB-тести — `*.db.test.ts` (проєкт `db`), без бази червоні; scratch-бази
  тестів створює й прибирає порт (`withShadow`), не ручний SQL у тестах.
- Коміти — Conventional Commits, опис українською, без трейлерів.
- Гейти в кожній задачі: scoped-тести, typecheck, lint, `pnpm format:check`,
  для задач 3–6 — `pnpm --filter simetra test:db`; перед фінальним рев'ю —
  повні кореневі гейти з `pnpm metadata:check` і `pnpm test:db`.

## Review Focus

1. **Тінь не лишається після помилки** — збій завантаження SQL у тінь
   (синтаксис, FK без засіву) прибирає тіньову базу; тест рахує бази
   `pgdelta_shadow_%` до й після. Задача 4.
2. **Політика не чіпає нічого поза керованими схемами** — план бази стеку
   проти тіні з рендером синтетичного домену не має жодного оператора поза
   `app` (ні `DROP EXTENSION`, ні `REVOKE … ON SCHEMA public`). Задача 4.
3. **Перестановка колонок ловиться**, хоча план двигуна порожній. Задача 5.
4. **Розбір дефініцій не губить ознак:** `NULLS NOT DISTINCT`,
   `DEFERRABLE INITIALLY DEFERRED`, `INCLUDE`, опклас, колляція, `DESC NULLS
   LAST`, частковий предикат, дії FK — кожна ознака має тест мапінгу.
   Задача 3.
5. **Об'єкт класу поза моделлю двигуна** (cast, statistics, text search
   config) дає діагностику, а не тихий порожній план. Задача 5.

---

### Task 0: Стабілізація тестів під навантаженням

**Files:**
- Modify: найповільніші тести компілятора (за профілем), `packages/simetra/vitest.config.ts` (за потреби)

Контекст: під паралельним навантаженням turbo (`pnpm test` з кореня) двічі
разово впали `codegen.test.ts` (таймаут) і один тест повного прогону
(не названий; `operations-delete` в ізоляції стабільний). Рерани зелені.

- [ ] **Step 1:** відтворити: `pnpm test` з кореня тричі поспіль; профіль —
  `pnpm --filter simetra exec vitest run --project unit --reporter=json
  --outputFile=<tmp>/times.json`; назвати десять найповільніших тестів і
  їхній час.
- [ ] **Step 2:** для кожного повільного тесту, що компілює той самий вхід
  кілька разів, — спільна компіляція в `beforeAll` (результат лише
  читається); якщо після цього тест-файл усе ще ближчий до 50% таймауту, —
  явний `timeout` на рівні файлу з коментарем-причиною. Глобальний таймаут
  не піднімати.
- [ ] **Step 3:** `pnpm test` з кореня тричі поспіль — зелено; у звіті —
  час до/після для змінених файлів.
- [ ] **Step 4: Commit** `test(compiler): стабільні тести під навантаженням — спільна компіляція фікстур`

---

### Task 1: Модель каталогу порту (T0)

**Files:**
- Create: `packages/simetra/src/model/physical/catalog.ts`
- Modify: `packages/simetra/src/model/index.ts`
- Test: `packages/simetra/src/model/__tests__/catalog-model.test.ts`

**Interfaces:**
- Produces (`simetra/model`):
  ```ts
  type CatalogColumn = Omit<PhysicalColumn, "origin">
  type CatalogTable = Omit<PhysicalTable, "origin" | "columns"> & { columns: CatalogColumn[] }
  type CatalogEnumType = Omit<PhysicalEnumType, "origin">
  interface CatalogUnit { class: SqlUnitClassName; identity: string; schema: string; name: string; sql: string }
  interface CatalogModel { tables: CatalogTable[]; enumTypes: CatalogEnumType[]; units: CatalogUnit[] }  // відсортовано як знімок; units — за identity
  interface CatalogDifference { path: string; kind: "missing" | "extra" | "changed" | "order"; detail: string }
  function catalogFromSnapshot(snapshot: PhysicalSnapshot): Pick<CatalogModel, "tables" | "enumTypes">
  function diffCatalogModels(a: CatalogModel, b: CatalogModel): CatalogDifference[]   // відсортовано за path
  ```
  `SqlUnitClassName` — рядковий union класів, що зараз у T1 `SqlUnitClass`;
  перенести тип у T0, T1 імпортує його звідти (один тип, без дубля).
  `diffCatalogModels` порівнює структурно: таблиці й енам-типи за
  `schema.name`, колонки **у порядку** (`kind: "order"`, коли ті самі колонки
  в іншому порядку), ключі, обмеження й індекси за іменем, одиниці за
  `identity` і текстом `sql`.
- [ ] **Step 1: Тести** — `catalog from snapshot drops origin`;
  `identical models have no differences`; `reordered columns are an order
  difference`; `missing and extra index`; `changed check expression`;
  `units compared by identity and text`.
- [ ] **Step 2:** червоні. **Step 3:** реалізація. **Step 4:** зелені, гейти.
- [ ] **Step 5: Commit** `feat(model): модель каталогу порту SchemaEngine і її порівняння`

---

### Task 2: Порт `SchemaEngine` і каркас адаптера pg-delta

**Files:**
- Create: `packages/simetra/src/schema/engine/port.ts`, `engine/pg-delta/adapter.ts`, `engine/pg-delta/policy.ts`, `engine/index.ts`
- Modify: `packages/simetra/package.json` (`dependencies`: `@supabase/pg-delta`, `pg`), `pnpm-lock.yaml`, `packages/simetra/src/schema/index.ts`, `compiler/index.ts` (експорт `loadSqlParser`, `SqlParser`), `docs/research/stack/reuse-map-2026-09.md` (версія й ліцензія pg-delta)
- Test: `packages/simetra/src/schema/__tests__/engine-policy.db.test.ts`

**Interfaces:**
- Produces (`simetra/schema`):
  ```ts
  interface DbConnection { url: string }
  interface EngineScope { schemas: readonly string[] }                 // керовані схеми
  interface EngineDiagnostic { code: RuleCode; severity: Severity; message: string; object?: string }
  interface EngineCatalog { readonly engine: string }                  // непрозорий; лише для plan
  interface Extracted { model: CatalogModel; catalog: EngineCatalog; diagnostics: EngineDiagnostic[] }
  interface EnginePlan { statements: string[]; empty: boolean; hazards: string[] }
  interface SchemaEngine {
    extract(db: DbConnection, scope: EngineScope): Promise<Extracted>
    plan(source: EngineCatalog, target: EngineCatalog, scope: EngineScope): EnginePlan   // чисто, без бази
    withShadow<T>(base: DbConnection, fn: (shadow: DbConnection) => Promise<T>): Promise<T>
  }
  function createPgDeltaEngine(): SchemaEngine
  ```
  `withShadow` — co-located база з `template0`, засіяна базовим станом
  провайдера з `base`, прибрана після `fn` завжди. Політика
  (`policy.ts`): `simetraPolicy(scope)` = `extends: [supabasePolicy]` + фільтр
  виключення «не керована схема й не її сателіт» (рішення плану 5).
- [ ] **Step 1: Тести** (`engine-policy.db.test.ts`) — `stack database with
  no managed schemas extracts an empty model` (extract бази стеку, `scope:
  { schemas: [] }` → порожні `tables`, `enumTypes`, `units`);
  `managed schema is kept` (тінь з `CREATE SCHEMA app; CREATE TABLE
  app.t(id int primary key)` → у моделі одна таблиця); `self plan is empty`
  (plan бази стеку проти самої себе, `scope: { schemas: ["app"] }` →
  `empty`).
- [ ] **Step 2:** червоні. **Step 3:** реалізація; мапінг моделі в цій
  задачі — лише таблиці з колонками (решта — задача 3); `withShadow` — повна.
- [ ] **Step 4:** зелені; гейти; `pnpm --filter simetra test:db engine`.
- [ ] **Step 5: Commit** `feat(schema): порт SchemaEngine і адаптер pg-delta — extract, plan, тінь`

---

### Task 3: Мапінг FactBase у модель каталогу

**Files:**
- Create: `packages/simetra/src/schema/engine/pg-delta/map-tables.ts`, `map-definitions.ts`, `map-units.ts`
- Modify: `engine/pg-delta/adapter.ts`
- Test: `packages/simetra/src/schema/__tests__/engine-definitions.test.ts` (юніт, без бази), `engine-extract.db.test.ts`

**Interfaces:**
- Consumes: `SqlParser` (T1), `readSqlUnits` (T1, класифікатор одиниць), типи задачі 1.
- Produces:
  ```ts
  // map-definitions.ts — чисті функції над текстом дефініції
  function parseConstraintDefinition(parse: SqlParser, table: { schema: string; name: string }, name: string, def: string):
    | { type: "primaryKey"; value: NonNullable<CatalogTable["primaryKey"]> }
    | { type: "unique"; value: CatalogTable["uniques"][number] }
    | { type: "check"; value: CatalogTable["checks"][number] }
    | { type: "foreignKey"; value: CatalogTable["foreignKeys"][number] }
    | { type: "exclude"; def: string }
  function parseIndexDefinition(parse: SqlParser, def: string): CatalogTable["indexes"][number]
  ```
  Форма значень — та сама, що в знімку (спека §8.3): значення Postgres за
  замовчуванням не пишуться (`ASC`, типове `NULLS`, `deferrable` PK/UNIQUE
  відсутнє для «no», FK пише `"no"`); колляція `pg_catalog."C"` → `{ name: "C" }`
  (як у схемі `CustomTable`: без `pg_catalog`); вираз CHECK — без обгортки
  `CHECK (...)`. Індекси, що підтримують PK/UNIQUE, у `indexes` не
  потрапляють (як у знімку). EXCLUDE-обмеження моделлю таблиці не
  виражається — воно стає SQL-одиницею (`ALTER TABLE … ADD CONSTRAINT`).
  Колонки — у порядку `_position`; `default` — з окремого факту `default`;
  identity — `{ generation, sequence }` з ім'ям послідовності; генерована —
  `generated.expression`. SQL-одиниці — рішення плану 4.
- [ ] **Step 1: Тести юніт** (`engine-definitions.test.ts`, тексти дефініцій
  дослівно з розвідки): `primary key`; `unique nulls not distinct deferrable
  initially deferred`; `check strips wrapper`; `foreign key with cascade and
  external target`; `exclude becomes a unit`; `partial expression index with
  opclass desc nulls last include` (`CREATE INDEX doc_title_idx ON app.doc
  USING btree (lower(title) text_pattern_ops DESC NULLS LAST) INCLUDE
  (amount) WHERE (status <> 'void'::app.status)`); `default ordering is
  omitted`.
- [ ] **Step 2: Тести з базою** (`engine-extract.db.test.ts`): для кожної
  фікстури E1 (`deploy.db.test.ts` — винести їхні побудовники в спільний
  модуль фікстур) і синтетичного домену: у `withShadow` розгорнути
  `renderDesiredState(model).sql`, extract зі `scope` = схеми моделі →
  `diffCatalogModels(extracted, { ...catalogFromSnapshot(model.physical), units: extracted.units })`
  дає відмінності **лише** в текстах виразів (`checks[].expression`,
  `default`, `generated`, `where`, ключі-вирази — Postgres канонізує їх);
  тест перелічує ці шляхи явно, будь-яка інша відмінність — червона.
  Окремо: `units carry compiler identities` — SQL-одиниці синтетичного домену
  (функції множини скоупу, обгортки рухів) мають ті самі `identity`, що
  `model.sqlUnits`.
- [ ] **Step 3:** червоні. **Step 4:** реалізація. **Step 5:** зелені, гейти.
- [ ] **Step 6: Commit** `feat(schema): extract мапить FactBase pg-delta у модель каталогу через libpg-query`

---

### Task 4: Тінь, політика й план бажаного стану

**Files:**
- Create: `packages/simetra/src/schema/engine/desired.ts`
- Modify: `engine/index.ts`
- Test: `packages/simetra/src/schema/__tests__/engine-shadow.db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface DesiredComparison {
    plan: EnginePlan                       // ціль → тінь
    target: Extracted; desired: Extracted
    differences: CatalogDifference[]       // diffCatalogModels(target.model, desired.model)
    diagnostics: EngineDiagnostic[]
    empty: boolean                         // plan.empty && differences.length === 0
  }
  function compareWithDesired(engine: SchemaEngine, target: DbConnection, desiredSql: string, scope: EngineScope): Promise<DesiredComparison>
  function managedSchemas(model: Pick<CompiledModel, "project" | "physical" | "sqlUnits">): string[]
  ```
  `compareWithDesired`: тінь від цілі → завантажити `desiredSql` → extract
  тіні й цілі → `plan` і `diffCatalogModels`. Помилка завантаження SQL у тінь
  — діагностика `engine.shadow-load-failed` з текстом помилки Postgres, а не
  виняток назовні; тінь прибрано. `managedSchemas` — `defaultSchema` проєкту,
  схеми таблиць, енам-типів і одиниць моделі, без схем провайдера
  (`UNMANAGED_SCHEMAS` рендера — один перелік).
- [ ] **Step 1: Тести** — `no shadow is left behind` (кількість баз
  `pgdelta_shadow_%` до й після: успіх і помилка завантаження однакові);
  `broken desired sql is a diagnostic`; `plan stays inside managed schemas`
  (Review Focus 2: ціль — база стеку, бажаний — рендер синтетичного
  домену; жоден оператор плану не згадує `public`, `extensions`,
  `DROP EXTENSION`, `REVOKE`); `foreign key to auth.users deploys in the
  shadow` (засів базового стану).
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(schema): порівняння бази з бажаним станом через тінь`

---

### Task 5: Перепис класів поза моделлю двигуна й тихі втрати

**Files:**
- Create: `packages/simetra/src/schema/engine/pg-delta/coverage.ts`
- Modify: `engine/pg-delta/adapter.ts`, `compiler/diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/schema/__tests__/engine-coverage.db.test.ts`

**Interfaces:**
- Produces: `COVERED_CLASSES: readonly string[]` (класи фактів, які покриває
  закріплена версія pg-delta — з її `COVERAGE.md`; список дублюється
  свідомо, бо двигун його не експортує, і контрактний тест ловить
  розбіжність); коди `engine.unmodeled-class` (error),
  `engine.matview-unpopulated` (warning); `dangling_edge` двигуна до порту не
  доходить.
- [ ] **Step 1: Тести** — `cast, statistics and text search config are
  diagnosed` (кожен об'єкт у тіні → `engine.unmodeled-class` з ім'ям об'єкта;
  план порожній, але `DesiredComparison.empty` — `false`, бо є помилки);
  `unpopulated materialized view is diagnosed`; `column order difference is
  not empty` (Review Focus 3: ціль — таблиця з колонками `a, b`, бажане —
  `b, a`; `plan.empty === true`, `differences` має `kind: "order"`,
  `empty === false`); `generated column noise is filtered` (генерована
  колонка → жодної діагностики `dangling_edge`); `covered classes match the
  pinned engine` (контрактний тест: читає `COVERAGE.md` із встановленого
  пакета й порівнює зі списком).
- [ ] **Step 2–4:** червоні → реалізація (`DesiredComparison.empty` —
  `false`, якщо є діагностика рівня error) → зелені, гейти.
- [ ] **Step 5: Commit** `feat(schema): перепис класів поза моделлю двигуна й власна перевірка тихих втрат`

---

### Task 6: Round-trip бажаного стану, контрактні тести порту, канон

**Files:**
- Create: `packages/simetra/src/schema/__tests__/engine-round-trip.db.test.ts`
- Modify: спека П2 §9 (рішення плану 7 — одне речення) і §10.4 (тінь — co-located база двигуна з базовим станом провайдера; транзакція з відкатом лишається для тестів E1), `docs/ROADMAP.md`

- [ ] **Step 1: Тести** — для кожної фікстури E1 і синтетичного домену:
  ціль — тінь із розгорнутим рендером (через `withShadow` від бази стеку),
  `compareWithDesired(engine, ціль, той самий рендер, scope)` → `empty`;
  негативні: ціль із зайвим індексом → план не порожній і `differences`
  називає індекс; ціль без однієї колонки → план має `ADD COLUMN`;
  ціль із переставленими колонками → `differences` `order`.
- [ ] **Step 2:** `pnpm --filter simetra test:db` — зелено; час прогону
  db-проєкту в звіті (тіні множать час — якщо понад 2× від E1, групувати
  фікстури в одну тінь).
- [ ] **Step 3: Канон** — спека §9: «Round-trip вимагає, крім порожнього
  плану двигуна, рівності моделей каталогу бази й тіні з порядком колонок:
  двигун не бачить порядку колонок і стану заповнення матеріалізованого
  подання»; §10.4 — тінь; ROADMAP: план E2a в рядку П2, «Зараз» — E2a
  виконано, далі E2b; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 4:** повні кореневі гейти й `pnpm test:db`.
- [ ] **Step 5: Commit** `test(schema): round-trip бажаного стану через порт SchemaEngine на корпусі фікстур`

---

## Поза E2a (у E2b)

- Зворотний генератор (модель каталогу → `CustomTable`, `PgEnum`,
  дослівний `*.sql`; логічні імена з фізичних за стилем проєкту), гучна
  помилка на невиражене, фікстури round-trip за класами (спека §9).
- Команди `simetra introspect <db-url> --out <dir>` і `simetra diff <db-url>
  [dir]` (лише читання бази; рішення власника 2026-10-02) і доповнення спеки
  §8.6–§8.7.
- Приватна звірка на schema-only копії першого споживача (§10.3) — виходи
  поза репо.
- Друга форма знімка при явному типовому опкласі чи колляції й асиметрія
  `deferrable` (борг F) — нормалізація у зворотному генераторі.

## Критерії приймання плану E2a

- `SchemaEngine` з адаптером pg-delta: extract у модель каталогу порту,
  чистий plan, тінь, що завжди прибирається.
- Модель каталогу збігається зі знімком компілятора на корпусі фікстур
  E1 і синтетичному домені (з точністю до канонізації виразів Postgres).
- Round-trip бажаного стану порожній на всьому корпусі; перестановка колонок,
  клас поза моделлю й незаповнене подання не дають тихого «порожньо».
- Політика не торкається нічого поза керованими схемами.
