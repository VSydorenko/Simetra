# П2, план E2a — порт `SchemaEngine`, адаптер pg-delta, тінь, звірка розгорнутого бажаного стану: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** порівнювати живу базу з бажаним станом не тестовим читачем, а
каталожним двигуном за власним портом: extract бази в модель каталогу
Simetra, структурований план двигуна між базою й тінню з рендером, перепис
класів об'єктів поза моделлю двигуна. Довести це звіркою розгорнутого
бажаного стану на корпусі фікстур E1 і синтетичному домені. Повний
round-trip (`extract → зворотна генерація → компіляція → тінь`, спека §9) —
E2b.

**Архітектура:** порт `SchemaEngine` (T2 `simetra/schema`) з діями
`extract`, `plan`, `withDesiredShadow`; перший адаптер — `@supabase/pg-delta`.
Модель каталогу порту — форма фізичного знімка T0 без `origin` плюс дослівні
SQL-одиниці (спека §9). Адаптер мапить у неї FactBase двигуна за явною
таблицею властивостей: кожна властивість факту або має поле моделі, або
стає SQL-одиницею, або дає гучну діагностику «не виражається». Тексти
дефініцій обмежень та індексів розбирає libpg-query. Порівняння виразів іде
між двома extract-ами (база ↔ тінь), тож канонічну форму дає Postgres. Тихі
втрати двигуна закриває власний вузький перепис каталогу, який спека §9
дозволяє явно.

**Технології:** TypeScript 7, Vitest 5, `@supabase/pg-delta`
**1.0.0-alpha.56** (точний пін), `pg` 8.23.1, libpg-query 17.7.4, локальний
стек Supabase (Postgres 17).

**Спека:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§8.3, §9, §10.4; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
Р6, §6.2, §6.4, §6.9; [карта перевикористання](../../research/stack/reuse-map-2026-09.md)
(рядки pg-delta, тінь).

**Передумова:** D2 приземлено. Перед стартом — `orient --plan` цього файлу.

**Серія:** D2 → **E2a** (цей) → E2b (зворотна генерація, фікстури класів,
повний round-trip, `simetra introspect`/`simetra diff`, приватна звірка) → П3.

## Рішення плану

1. **Порт — у T2 флагманського пакета** (платформна спека §3.1: «порт
   `SchemaEngine` і його адаптер»). `pg` і `@supabase/pg-delta` стають
   runtime-залежностями `simetra`; лінт-зони T2 це дозволяють, T0/T1
   лишаються чистими.
2. **Спершу спайк, потім інтерфейси** (задача 1): засів тіні базовим станом
   провайдера, межа керування за §6.9 і представність фактів перевіряються на
   закріпленій версії до того, як порт фіксує контракт. Висновки — у
   `docs/research/`; якщо публічного засобу засіву немає, — стоп і рішення
   архітектора, а не внутрішній імпорт пакета. **Рішення за спайком:**
   публічного засіву в `1.0.0-alpha.56` немає (`deriveAssumedSchemaSeed` не
   експортовано), тож тінь — лише бажана: порт створює co-located тінь
   (`provisionCoLocatedShadow`), передає її пул у `planSchemaFiles({
   seedAssumedSchemas: true })` з бажаним SQL як файлом і після повернення
   сам читає тінь (extract, перепис, порівняння моделей), прибираючи її в
   `finally`. Порожньої тіні для довільного вмісту порт не дає.
3. **Межа керування — за платформною спекою §6.9**, а не лише схеми:
   `EngineScope` = керовані схеми застосунку цілком (зокрема `public`, якщо
   застосунок у ній живе) **плюс** об'єкти застосунку в чужих схемах із
   пресета провайдера — політики на таблицях провайдера, тригери на таблиці
   користувачів, членство в publications, розширення, гранти й типові
   привілеї. Внутрішні об'єкти провайдера — поза межею. `UNMANAGED_SCHEMAS`
   рендера означає «схему не створювати», а не «її об'єктами не керувати».
   Межу перевіряють структуровані цілі дій плану, а не пошук слів у SQL.
4. **Модель каталогу порту — у T0** (`model/physical/catalog.ts`): таблиці й
   енам-типи у формі знімка без `origin` плюс SQL-одиниці
   `{ class, identity, schema, name, sql }`. FactBase назовні порту не
   виходить (лише непрозорий `EngineCatalog` для `plan`).
5. **Мапінг фактів — за явною таблицею властивостей** (задача 1 складає,
   задача 4 реалізує): поле моделі, SQL-одиниця або діагностика
   `engine.unrepresentable` з ім'ям об'єкта й властивості. Значення
   властивостей, яких модель не має (`persistence` ≠ звичайна,
   `replicaIdentity` ≠ типова, секціонування, `constraint.validated = false`,
   `index.valid = false`, EXCLUDE-обмеження тощо), — гучна помилка, не тиха
   втрата. Форма EXCLUDE у моделі — окреме рішення власника поза E2a.
6. **SQL-одиниці — з фактів класів, які модель тримає дослівно**
   (функції, процедури, агрегати, тригери, політики, в'юхи, гранти, типові
   привілеї, publication, розширення, домени, послідовності): текст
   оператора — з дефініції факту двигуна або з дії плану «порожня база →
   факт», згрупованої за `produces` цього факту; одна дія на факт, інакше —
   `engine.unrepresentable`. Ідентичність одиниці — той самий класифікатор,
   що в компіляторі (`readSqlUnits`), і лише для операторів його дозволеної
   мови (спека §8.3: `CREATE INDEX` — не одиниця).
7. **Звірка вимагає і порожнього плану двигуна, і рівності моделей каталогу
   з порядком колонок:** двигун не бачить порядку колонок (`_position` поза
   хешем) і стану заповнення матеріалізованого подання. Спека §9
   доповнюється одним реченням.
8. **Перепис класів — власний вузький запит до каталогу** (спека §9:
   «простий запит до каталогу, що лише рахує об'єкти за класами, а не
   читач») у межі керування, звірений із покриттям двигуна
   (`COVERED_CLASSES`); він же рахує незаповнені матеріалізовані подання —
   доведену прогалину двигуна. Діагностики двигуна `unmodeled_kind` —
   додатковий сигнал, не єдине джерело.
9. **План порту — структурований:** дії зберігають `sql`, дієслово, цілі
   (`produces`/`destroys`), транзакційність, клас блокування, втрату даних і
   ризик перезапису — потоку П3 (платформна спека §6.2) вони потрібні.
10. **Тестовий читач `test/db/catalog.ts` лишається незалежним оракулом**
    тестів E1 і не стає продуктовим читачем.

## Рішення за спайком

Спайк — [pg-delta-e2a-spike-2026-10.md](../../research/schema-engine/pg-delta-e2a-spike-2026-10.md);
відповіді на його «Питання до плану E2a»:

1. **Тінь-сирота після сигналу** (`finally` не виконується): тести рахують
   бази `pgdelta_shadow_%` до й після прогону, не покладаючись на ім'я.
   Прибирання сиріт — борг поза E2a (команда CLI чи старт порту, П3).
2. **Межа перевіряється за `produces` ∪ `consumes` ∪ `destroys`:** GRANT,
   `ENABLE/FORCE RLS`, `REPLICA IDENTITY`, `OWNED BY`, `DISABLE TRIGGER` і
   REVOKE мають порожні `produces`/`destroys`; `EngineAction` несе й
   `consumes`.
3. **`REPLICA IDENTITY` — одиниця класу `replicaIdentity`** (мова
   компілятора її приймає); негативні приклади Review Focus 4 —
   `UNLOGGED`-таблиця й `NOT VALID`-обмеження.
4. **`functionSettings`** база тримає всередині дефініції функції: у
   порівнянні ідентичностей задачі 4 одиниця `functionSettings`
   компілятора зводиться до ідентичності своєї функції (перелік «класи, які
   база тримає інакше»).
5. **Зернистість:** extract дає одиницю на пару факту двигуна (об'єкт ×
   роль для `grant`/`defaultPrivileges`, publication × таблиця); для
   порівняння ідентичностей задачі 4 оператори компілятора розгортаються в
   ті самі пари (за деревом розбору).
6. **Керована схема керується цілком, зокрема її гранти й типові
   привілеї** (платформна спека §6.9 включає їх у межу). Правило спайку
   «гранти й ADP у `public` — за провайдером» відхилено: якщо `public`
   керована, бажаний стан оголошує її гранти й ADP явно (зворотна генерація
   E2b видасть їх із бази), і тоді REVOKE для `anon`/`authenticated`/`service_role`
   не з'являється. Тест межі (задача 3) — фікстура з керованою `public`, у
   бажаному SQL якої ці гранти й ADP оголошено, дає порожнє порівняння.
7. **`dangling_edge`** адаптер відфільтровує (на засіяній тіні їх десять).
8. **ACL власника, що дорівнює типовому** (`_ownerDefault`), — не одиниця
   й не відмінність; явне відкликання прав власника — одиниця.

## Уточнення під час виконання

Контракт, який фактично реалізовано (рішення архітектора в ході E2a):

- `EngineAction.transactionality: "transactional" | "nonTransactional" |
  "commitBoundaryAfter"` замість булевого поля — межу коміту (`ALTER TYPE …
  ADD VALUE`) потребує потік П3.
- Гілка `loaded` результату `withDesiredShadow` несе `diagnostics`
  (завантаження, ціль, дрейф двигуна); кожна діагностика порту має власний
  код `engine.*` (`engine.unmodeled-drift` — error, невідомий код двигуна —
  `engine.diagnostic` warning), а код двигуна — лише довідкове `engineCode`.
- `COVERED_CLASSES` — класи, для яких двигун дає факт (єдине джерело —
  таблиця перепису, типізована `FactKind` закріпленої версії); клас із
  фактом, але без форми в моделі, мапер віддає поіменно як
  `engine.unrepresentable`. Лічильники покритих класів звіряються з фактами
  extract — розбіжність `engine.census-mismatch`.
- Неявні значення моделі каталогу: гранти, що дорівнюють типовим привілеям
  схеми, коментар розширення з control-файлу, типовий ACL власника.
- Компілятор: типові привілеї схеми передують її об'єктам у порядку
  створення (виправлення T1, спека §8.3).
- `parseIndexDefinition` повертає індекс або `unrepresentable` (`WITH`,
  tablespace, `ON ONLY`); FORCE RLS без ENABLE — `unrepresentable`.

## Global Constraints

- Ярус: порт, адаптер, тінь і перепис — `packages/simetra/src/schema/engine/`;
  типи моделі каталогу — T0 `src/model/physical/catalog.ts` (лише типи й
  чисті функції). Імпорти — лише вниз.
- `@supabase/pg-delta` — рівно `1.0.0-alpha.56` (тег `latest` на npm —
  заглушка 0.0.0). Ліцензійні факти: у тарболі цієї версії — MIT; у репо
  джерела з 2026-10-02 — PostgreSQL License; обидві дозволені
  `CONTRIBUTING.md`. Інша версія — лише окремим рішенням із повтором
  розвідки й тестів. `pg` — рівно `8.23.1`, переходить у `dependencies`.
  `reuse-map-2026-09.md` оновити (версія, обидві ліцензії).
- Перейменування двигуна вимкнені завжди (`renames: "off"`): `physicalName`
  стабільний (спека §3).
- Порт не застосовує план до бази-цілі: `apply`/`provePlan` — П3. Тінь —
  єдина база, у яку порт пише, і її прибирають завжди, зокрема при помилці.
- Тексти діагностик порту — англійською з `en`/`uk`/`hint` у `MESSAGES`;
  коди — у `COMPILER_RULES` (простір `engine.*`).
- DB-тести — `*.db.test.ts`, без бази червоні; scratch-бази тестів створює й
  прибирає порт (`withDesiredShadow`).
- Коміти — Conventional Commits, опис українською, без трейлерів.
- Гейти в кожній задачі: scoped-тести, typecheck, lint, `pnpm format:check`,
  для задач 3–7 — `pnpm --filter simetra test:db`; перед фінальним рев'ю —
  повні кореневі гейти з `pnpm metadata:check` і `pnpm test:db`.

## Review Focus

1. **Тінь не лишається після помилки** — кількість баз `pgdelta_shadow_%`
   до й після прогону з помилкою завантаження однакова. Задача 6.
2. **Межа керування за §6.9:** план не має дій із цілями поза межею (за
   `produces`/`destroys`), але має дії для політики на `storage.objects`,
   тригера на `auth.users` і застосунку в `public`. Задачі 3 і 6.
3. **Перестановка колонок ловиться**, хоча план двигуна порожній. Задача 7.
4. **Властивість без поля моделі не губиться** — `UNLOGGED`-таблиця й
   `NOT VALID`-обмеження дають `engine.unrepresentable`. Задача 4.
5. **Об'єкт класу поза моделлю двигуна й незаповнене подання** дають
   діагностику перепису, а не тихе «порожньо». Задача 5.

---

### Task 0: Флейки під навантаженням — відтворити або закрити

Контекст: під паралельним навантаженням turbo двічі разово впали таймаут
`codegen.test.ts` і один неназваний тест повного прогону; рерани зелені.

- [ ] **Step 1:** `pnpm test` з кореня п'ять разів поспіль; профіль —
  `pnpm --filter simetra exec vitest run --project unit --reporter=json
  --outputFile=<tmp>/times.json`, десять найповільніших тестів із часом.
- [ ] **Step 2:** якщо збій відтворився — виправити причину в тесті
  (спільна компіляція фікстур у `beforeAll`, без зміни глобального
  таймауту), п'ять зелених прогонів, коміт
  `test(compiler): стабільні тести під навантаженням`. Якщо не відтворився —
  без змін коду: профіль і висновок у звіт задачі, коміту немає.

---

### Task 1: Спайк API pg-delta під контракт порту

**Files:**
- Create: `docs/research/schema-engine/pg-delta-e2a-spike-2026-10.md`; рядок в індексі `docs/research/README.md`
- Скрипти спайку — у scratch-теці поза репо (не комітяться)

Перевірити на `1.0.0-alpha.56` проти локального стеку (scratch-бази через
`provisionCoLocatedShadow`, прибрати всі) і записати відповіді з доказом
(фрагмент виклику й виходу):

- [ ] **Step 1: Засів тіні.** Чи є **публічний** експорт, що засіває
  co-located тінь базовим станом провайдера з бази-цілі
  (`deriveAssumedSchemaSeed` чи інший), або засів доступний лише всередині
  `planSchemaFiles`. Доказ: у засіяній тіні розгортається FK на
  `auth.users`; після збою завантаження тінь прибрано. **Якщо публічного
  засобу немає — стоп і повідомлення архітектору** з варіантами (засів через
  `planSchemaFiles` як єдиний вхід тіні, власний засів із моделі каталогу
  бази-цілі, інше).
- [ ] **Step 2: Межа §6.9.** Політика (`extends: [supabasePolicy]` +
  фільтр), за якої в межі: усі об'єкти керованих схем (зокрема `public` як
  керованої), політика на `storage.objects`, тригер на `auth.users`,
  членство таблиці в publication, розширення, гранти, типові привілеї; поза
  межею — внутрішні об'єкти провайдера й некеровані схеми. Записати форму
  фільтра і як визначається «об'єкт застосунку в чужій схемі».
- [ ] **Step 3: Таблиця властивостей.** Для кожного класу фактів, який
  зустрічається в межі, — кожна властивість payload → поле моделі каталогу /
  SQL-одиниця / «не виражається»; для класів-одиниць — звідки береться текст
  (`def` факту чи дія плану з `produces`) і чи одна дія на факт.
- [ ] **Step 4: Перепис.** Запит до `pg_catalog`, що рахує об'єкти за
  класами в межі (зокрема cast, operator, opclass, statistics, text search,
  незаповнені матеріалізовані подання), і відповідність його класів
  класам фактів двигуна.
- [ ] **Step 5: Commit** `docs(research): спайк pg-delta під контракт порту SchemaEngine`

---

### Task 2: Модель каталогу порту (T0)

**Files:**
- Create: `packages/simetra/src/model/physical/catalog.ts`
- Modify: `packages/simetra/src/model/index.ts`; `compiler/sql/units.ts` (тип класу одиниці переходить у T0, T1 імпортує)
- Test: `packages/simetra/src/model/__tests__/catalog-model.test.ts`

**Interfaces:**
- Produces (`simetra/model`):
  ```ts
  type CatalogColumn = Omit<PhysicalColumn, "origin">
  type CatalogTable = Omit<PhysicalTable, "origin" | "columns"> & { columns: CatalogColumn[] }
  type CatalogEnumType = Omit<PhysicalEnumType, "origin">
  interface CatalogUnit { class: SqlUnitClassName; identity: string; schema: string; name: string; sql: string }
  interface CatalogModel { tables: CatalogTable[]; enumTypes: CatalogEnumType[]; units: CatalogUnit[] }  // сортування як у знімку; units — за identity
  interface CatalogDifference { path: string; kind: "missing" | "extra" | "changed" | "order"; detail: string }
  function catalogFromSnapshot(snapshot: PhysicalSnapshot): Pick<CatalogModel, "tables" | "enumTypes">
  function diffCatalogModels(a: CatalogModel, b: CatalogModel): CatalogDifference[]   // за path
  ```
  `diffCatalogModels` — структурно: таблиці й енам-типи за `schema.name`,
  колонки **в порядку** (ті самі колонки в іншому порядку — `kind: "order"`),
  ключі, обмеження й індекси за іменем, одиниці за `identity` і текстом.
- [ ] **Step 1: Тести** — `catalog from snapshot drops origin`; `identical
  models have no differences`; `reordered columns are an order difference`;
  `missing and extra index`; `changed check expression`; `units compared by
  identity and text`.
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(model): модель каталогу порту SchemaEngine і її порівняння`

---

### Task 3: Порт, політика межі, тінь

**Files:**
- Create: `packages/simetra/src/schema/engine/port.ts`, `engine/pg-delta/adapter.ts`, `engine/pg-delta/policy.ts`, `engine/index.ts`
- Modify: `packages/simetra/package.json` (`dependencies`), `pnpm-lock.yaml`, `src/schema/index.ts`, `compiler/index.ts` (експорт `loadSqlParser`, `SqlParser`), `docs/research/stack/reuse-map-2026-09.md`
- Test: `packages/simetra/src/schema/__tests__/engine-scope.db.test.ts`

**Interfaces:**
- Produces (`simetra/schema`):
  ```ts
  interface DbConnection { url: string }
  interface EngineScope {
    schemas: readonly string[]                 // схеми застосунку цілком
    provider: "supabase"                       // пресет «об'єкти застосунку в чужих схемах» (§6.9)
  }
  interface EngineDiagnostic { code: RuleCode; severity: Severity; message: string; object?: string }
  interface EngineCatalog { readonly engine: string }                     // непрозорий
  interface Extracted { model: CatalogModel; catalog: EngineCatalog; diagnostics: EngineDiagnostic[] }
  interface EngineAction {
    sql: string; verb: "create" | "alter" | "drop"
    produces: string[]; consumes: string[]; destroys: string[]   // ідентичності об'єктів (рядкова форма StableId двигуна)
    transactional: boolean; lockClass: string; dataLoss: boolean; rewriteRisk: boolean
  }
  interface EnginePlan { actions: EngineAction[]; empty: boolean }
  interface SchemaEngine {
    extract(db: DbConnection, scope: EngineScope): Promise<Extracted>
    plan(source: EngineCatalog, target: EngineCatalog, scope: EngineScope): EnginePlan   // чисто, без бази
    withDesiredShadow<T>(target: DbConnection, desiredSql: string, scope: EngineScope,
      fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>):
      Promise<{ status: "loaded"; value: T } | { status: "shadow-failed"; diagnostics: EngineDiagnostic[] }>
  }
  function createPgDeltaEngine(): SchemaEngine
  ```
  Політика й засів — за висновками задачі 1 (рішення плану 2).
  `plan` у колбеку — ціль → тінь від `planSchemaFiles` у формі порту;
  тест доводить, що він дорівнює `plan(extract(ціль), extract(тінь))`.
  `EngineCatalog` несе розв'язані опції профілю разом із FactBase.
  `withDesiredShadow` прибирає тінь у `finally`; тести, яким потрібна тінь
  із довільними об'єктами, передають їх як `desiredSql`. Мапінг моделі в цій задачі — лише таблиці з колонками
  (решта — задача 4).
- [ ] **Step 1: Тести** — `stack database with no managed schemas extracts
  an empty model`; `managed schema is kept`; `self plan is empty`;
  `scope follows 6.9` (тінь: таблиця в `public` як керованій схемі, політика
  на `storage.objects`, тригер на `auth.users`; plan «порожня тінь → ця
  тінь» має дії для кожного з трьох; `shadow plan equals port plan` і жодної з `produces` у внутрішніх
  об'єктах провайдера чи некерованій схемі).
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(schema): порт SchemaEngine і адаптер pg-delta — extract, структурований plan, тінь`

---

### Task 4: Мапінг фактів у модель каталогу

**Files:**
- Create: `packages/simetra/src/schema/engine/pg-delta/map-tables.ts`, `map-definitions.ts`, `map-units.ts`
- Modify: `engine/pg-delta/adapter.ts`, `compiler/diagnostics.ts`, `messages.ts` (`engine.unrepresentable`)
- Test: `packages/simetra/src/schema/__tests__/engine-definitions.test.ts` (юніт), `engine-extract.db.test.ts`

**Interfaces:**
- Consumes: `SqlParser`, `readSqlUnits` (T1); таблиця властивостей задачі 1.
- Produces:
  ```ts
  function parseConstraintDefinition(parse: SqlParser, table: { schema: string; name: string }, name: string, def: string):
    | { type: "primaryKey"; value: NonNullable<CatalogTable["primaryKey"]> }
    | { type: "unique"; value: CatalogTable["uniques"][number] }
    | { type: "check"; value: CatalogTable["checks"][number] }
    | { type: "foreignKey"; value: CatalogTable["foreignKeys"][number] }
    | { type: "unrepresentable"; reason: string }                       // EXCLUDE тощо
  function parseIndexDefinition(parse: SqlParser, def: string): CatalogTable["indexes"][number]
  ```
  Форма значень — як у знімку (спека §8.3): типові значення Postgres не
  пишуться (`ASC`, типове `NULLS`, `deferrable` PK/UNIQUE відсутнє для «no»,
  FK пише `"no"`); колляція `pg_catalog."C"` → `{ name: "C" }`; вираз CHECK —
  без обгортки `CHECK (...)`; індекси PK/UNIQUE до `indexes` не потрапляють;
  колонки — за `_position`; `default` — з окремого факту; identity —
  `{ generation, sequence }`. Одиниці — рішення плану 6. Кожен рядок таблиці
  властивостей задачі 1 має гілку: поле, одиниця або
  `engine.unrepresentable`.
- [ ] **Step 1: Тести юніт** (тексти дефініцій дослівно з розвідки):
  `primary key`; `unique nulls not distinct deferrable initially deferred`;
  `check strips wrapper`; `foreign key with cascade and external target`;
  `exclude is unrepresentable`; `partial expression index with opclass desc
  nulls last include`; `default ordering is omitted`.
- [ ] **Step 2: Тести з базою** — для кожної фікстури E1 (побудовники з
  `deploy.db.test.ts` винести в спільний модуль фікстур) і синтетичного
  домену: рендер у тіні → extract → `diffCatalogModels` проти
  `catalogFromSnapshot(model.physical)` дає відмінності лише за явно
  переліченими шляхами текстів виразів; кожен такий вираз у моделі
  непорожній. Одиниці: множина `identity` з extract = множина `identity`
  `model.sqlUnits` (з урахуванням класів, які база тримає інакше — перелік
  у тесті з причинами). Негативні (Review Focus 4): `UNLOGGED`-таблиця,
  `NOT VALID`-FK → `engine.unrepresentable` з ім'ям об'єкта;
  `REPLICA IDENTITY FULL` → одиниця `replicaIdentity`.
- [ ] **Step 3–5:** червоні → реалізація → зелені, гейти.
- [ ] **Step 6: Commit** `feat(schema): extract мапить факти pg-delta у модель каталогу — поле, одиниця або гучна помилка`

---

### Task 5: Перепис класів і тихі втрати двигуна

**Files:**
- Create: `packages/simetra/src/schema/engine/census.ts`
- Modify: `engine/pg-delta/adapter.ts`, `compiler/diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/schema/__tests__/engine-census.db.test.ts`

**Interfaces:**
- Produces: `COVERED_CLASSES: readonly string[]` (класи, які адаптер
  покриває моделлю чи одиницями); `readCensus(db, scope): Promise<{ class:
  string; count: number }[]>` — запит задачі 1, лише лічильники; коди
  `engine.unmodeled-class` (error: клас поза `COVERED_CLASSES` з
  ненульовим лічильником у межі), `engine.matview-unpopulated` (error: модель
  не виражає стан заповнення). `dangling_edge` двигуна до порту не доходить.
- [ ] **Step 1: Тести** — `unmodeled classes are counted` (cast,
  statistics, text search config у тіні → діагностика за класом із
  лічильником); `unpopulated materialized view is diagnosed` (два extract-и й
  план однакові, лічильник перепису — ні); `generated column noise is
  filtered`; `covered classes match the pinned engine` (контрактний тест:
  кожен клас фактів двигуна, що трапляється в корпусі, — у
  `COVERED_CLASSES` або в переписі).
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(schema): перепис класів у межі керування й діагностика тихих втрат двигуна`

---

### Task 6: Порівняння бази з бажаним станом

**Files:**
- Create: `packages/simetra/src/schema/engine/desired.ts`
- Modify: `engine/index.ts`
- Test: `packages/simetra/src/schema/__tests__/engine-desired.db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type DesiredComparison =
    | { status: "compared"; plan: EnginePlan; target: Extracted; desired: Extracted
        differences: CatalogDifference[]; diagnostics: EngineDiagnostic[]; empty: boolean }
    | { status: "shadow-failed"; diagnostics: EngineDiagnostic[] }      // engine.shadow-load-failed з текстом Postgres
  function compareWithDesired(engine: SchemaEngine, target: DbConnection, desiredSql: string, scope: EngineScope): Promise<DesiredComparison>
  function engineScope(model: Pick<CompiledModel, "project" | "physical" | "sqlUnits">): EngineScope
  ```
  `empty` = порожній план, нуль `differences` і жодної діагностики рівня
  error (перепис, `unrepresentable`). `engineScope` — схеми застосунку з
  моделі (`defaultSchema`, схеми таблиць, енам-типів і одиниць) з
  урахуванням рішення плану 3.
- [ ] **Step 1: Тести** — `no shadow is left behind` (успіх і помилка);
  `broken desired sql is shadow-failed`; `plan stays inside the scope`
  (Review Focus 2 за `produces`/`destroys`); `foreign key to auth.users
  deploys in the shadow`.
- [ ] **Step 2–4:** червоні → реалізація → зелені, гейти.
- [ ] **Step 5: Commit** `feat(schema): порівняння бази з бажаним станом через тінь`

---

### Task 7: Звірка розгорнутого бажаного стану на корпусі, канон

**Files:**
- Create: `packages/simetra/src/schema/__tests__/engine-desired-corpus.db.test.ts`
- Modify: спека П2 §9 і §10.4, `docs/ROADMAP.md`

- [ ] **Step 1: Тести** — для кожної фікстури E1 і синтетичного домену:
  ціль — тінь із розгорнутим рендером (вкладений `withDesiredShadow`), `compareWithDesired` з тим самим
  рендером → `empty`. Мутаційні (кожна мутація цілі → не `empty` і
  відмінність або дія називає об'єкт): зайвий індекс; відсутня колонка;
  переставлені колонки (Review Focus 3: `plan.empty`, але `differences`
  `order`); змінене тіло функції; змінений вираз CHECK; змінений предикат
  часткового індексу.
- [ ] **Step 2:** `pnpm --filter simetra test:db` — зелено; час db-проєкту
  в звіті (якщо понад 2× від E1 — групувати фікстури в одну тінь).
- [ ] **Step 3: Канон** — спека §9: звірка й round-trip вимагають, крім
  порожнього плану двигуна, рівності моделей каталогу з порядком колонок і
  чистого перепису класів; §10.4: тінь — co-located база двигуна з базовим
  станом провайдера (транзакція з відкатом лишається для тестів E1); ROADMAP:
  план E2a в рядку П2, «Зараз» — E2a виконано, далі E2b;
  `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 4:** повні кореневі гейти й `pnpm test:db`.
- [ ] **Step 5: Commit** `test(schema): звірка розгорнутого бажаного стану через порт на корпусі фікстур`

---

## Поза E2a (у E2b)

- Зворотний генератор (модель каталогу → `CustomTable`, `PgEnum`,
  дослівний `*.sql`; логічні імена з фізичних за стилем проєкту), повний
  round-trip `extract → зворотна генерація → компіляція → тінь` і фікстури
  за класами (спека §9).
- Команди `simetra introspect <db-url> --out <dir>` і `simetra diff <db-url>
  [dir]` (лише читання бази; рішення власника 2026-10-02) і доповнення спеки
  §8.6–§8.7.
- Приватна звірка на schema-only копії першого споживача (§10.3).
- Друга форма знімка при явному типовому опкласі чи колляції й асиметрія
  `deferrable` (борг F) — нормалізація у зворотному генераторі.
- Форма EXCLUDE-обмежень у моделі — рішення власника.

## Критерії приймання плану E2a

- `SchemaEngine` з адаптером pg-delta: extract у модель каталогу порту з
  гучною помилкою на невиражене, структурований plan, тінь, що завжди
  прибирається.
- Межа керування відповідає платформній спеці §6.9 і перевіряється за
  цілями дій плану.
- Звірка розгорнутого бажаного стану порожня на всьому корпусі; мутації,
  перестановка колонок, клас поза моделлю й незаповнене подання не дають
  тихого «порожньо».
