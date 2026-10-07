# Промоція-2b — декларативні властивості рамки, `EventSubscription`, закритий SQL-модуль, ратчет боргу: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** відхилення від рамки, які сьогодні можна написати лише дослівним
SQL, стають декларативними властивостями метаданих із закритою множиною
значень (спека промоції §9.3), а SQL-модуль об'єкта виду 1С приймає лише
закриті форми §9.4; дослівний SQL поза закритими формами — борг під
ратчетом, який лише зменшується.

**Архітектура:** T0 отримує нові поля реквізиту (`defaultValue` з `fill` і
`empty`, `unique: "ignoreCase"`, `uniqueWithin`, межі й формат), об'єкта
(`indexes`, `publicRead`), проєкту (`storageBuckets`), новий вид без сховища
`EventSubscription` і пресет джерел підписок провайдера; T1 виводить із них
фізику знімка (DEFAULT, CHECK, унікальні й складені індекси) і контракти
для П3 (`publicRead`, бакети, підписки). Гейт SQL розрізняє модуль виду
(лише закриті форми), борг (`CustomTable`, `PgEnum`, спільні
`metadata/sql/`) і функції множини; правило рядка після перевірки
граматики вкладається у знімок як CHECK таблиці. Перелік боргу —
`metadata/sql-debt.json`, який пише `introspect` і лише звужує `fix`.

**Технології:** TypeScript 7, Zod 4, Vitest, libpg-query 17.7.4 (wasm, без
зміни; парсера PL/pgSQL немає), локальний стек Supabase (Postgres 17).

**Спека:** [спека промоції](../specs/2026-10-06-promotion-design.md) §1,
§9.2, §9.3, §9.4, Пр1, Пр7, Пр11, Пр12; [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§3 («Дослівний SQL», «Файли»), §4–§5, §8.2 (стадії 4–5), §8.3, §8.6;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) §6.7,
§6.8, §6.9. Правки спек під рішення цього плану вносить задача 1 плану
[2a](2026-10-07-promotion-2a-kind-label-assigned-once.md) — перед стартом
перевірити, що вони закомічені.

**Передумова:** план 2a виконано повністю (мітка виду, `ASSIGNED_ONCE`,
переїзд ратчета полів у `packages/simetra/test/`, `elementChecks`);
`orient --plan` цього файлу; локальний стек (`pnpm db:start`). На checkout
працює одна сесія, що комітить.

**Архітектор задачі:** сесія `consumer-reconciliation`. Розвилки — до неї
(`SendMessage`); якщо сесії немає — до власника.

**Поза планом (свідомо):** `access` і декларація видів доступу — план
генерації політик (П3, спека промоції §16 п.5); генерація тригерів
підписок, політик `publicRead` і бакетів — П3; заборона динамічного SQL у
plpgsql — план переписувача (парсер PL/pgSQL) і `plpgsql_check` у тіні П3;
названа перевірка викликача й `EXECUTE` у TS-декларації — П4; `immutable`,
`ordered` (без доказів, §9.2); довідник «мітка → об'єкт».

## Global Constraints

- 🔴 **Розбіжність спеки з кодом — стоп.** Поведінка коду, не описана тут
  чи у спеці, — виконавець зупиняється і звітує архітекторові.
- 🔴 **Ратчет полів:** кожне нове поле схем виставлене в
  `packages/simetra/src/compiler/__tests__/fixtures/kitchen-sink.ts` і
  прочитане стадією, знімком, контрактом, кодогеном або читачем T2;
  `packages/simetra/test/field-ratchet.test.ts` зелений без нових винятків.
- Схема дозволяє лише те, що приймає компілятор (спека П2 §8.2, стадія 1):
  поле, яке правило завжди відхиляє, у схемі цього виду не існує.
- Кожне розгалуження за видом читає реєстр видів; нові факти — поля
  `KindDefinition`, а не перевірка імені виду.
- Нове правило — рядок у `SCHEMA_RULES` (`model/schemas/rules.ts`) або
  `COMPILER_RULES` (`compiler/diagnostics.ts`) і тексти en/uk у
  `compiler/messages.ts`. Поля нових схем мають `.meta({ description })`.
- Після зміни Zod-форми — `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`.
- Фізика виводиться в T1 у знімок; рендер T2 вміє `DEFAULT`, `CHECK`,
  `COLLATE`, виразні й складені індекси — нових рендер-функцій не писати.
- Без шимів; коментарі — українською, «чому»; 🔴 без `--` перед шаблоном
  vitest; коміти — Conventional Commits українською, без трейлерів.

## Рішення плану

Рішення 1–9 ухвалив архітектор задачі (сесія `consumer-reconciliation`)
2026-10-07; 10–14 — дрібні рішення автора плану, прийняті архітектором.

1. **Значення заповнення:** `defaultValue` — скаляр (як зараз), або
   `{ fill: "now" | "today" | "newUuid" }`, або `{ empty: true | "object" |
   "array" }`. `fill` лише на скалярі: `now` — `DateTime` → `now()`;
   `today` — `Date` → `(now() AT TIME ZONE '<project.timezone>')::date`;
   `newUuid` — `UUID` → `gen_random_uuid()`. `{ empty: true }` — лише
   `array: true` будь-якого типу → `'{}'`; скалярний `Json` — `{ empty:
   "object" }` → `'{}'::jsonb`, `{ empty: "array" }` → `'[]'::jsonb`. Інше
   поєднання — помилка схеми з підказкою форми.
2. **`unique: true | "ignoreCase"`**; `ignoreCase` — лише скалярні String і
   Text → унікальний індекс `(носій скоупу?, …, lower(<колонка>))`.
   **`uniqueWithin: "owner" | "parent"`** — лише з `unique`, лише в
   реквізитах самого об'єкта (не ТЧ) і лише коли вид об'єкта з його
   налаштуваннями має стандартну колонку `owner` / `parent` (факт зі
   `standardColumns`, не ім'я виду); ключ — носій скоупу, колонки власника
   (пара для поліморфного) чи батька, колонка; для `parent` — `NULLS NOT
   DISTINCT` (верхній рівень ієрархії — `NULL`). Внутрішнє поле
   `Field.uniqueWithin` у `stages/model.ts` (носій скоупу UNIQUE)
   перейменовується на `uniqueCarrier`, щоб не плутати з властивістю.
3. **Межі й формат:** `nonNegative: true`, `positive: true`, `minValue`,
   `maxValue` (число чи рядок десяткового дробу, у межах типу) — лише
   скалярні Integer, SmallInt, BigInt, Numeric; `positive` і `nonNegative`
   взаємовиключні; `minValue <= maxValue`. `pattern` (рядок, що
   компілюється `new RegExp(p, "u")`) і `minLength` (ціле > 0) — лише
   скалярні String і Text. Фізика: один CHECK `<таблиця>_<колонка>_bounds`
   (умови через `AND`) і один `<таблиця>_<колонка>_format` (`<колонка> ~
   '<pattern>'`, `char_length(<колонка>) >= n`); `NULL` проходить.
4. **`indexes`** на Catalog, Document і їхніх ТЧ (факт реєстру
   `compositeIndexes: true`): `[{ attributes: [<ім'я> | { name, order:
   "desc" }] }]`, імена — логічні імена реквізитів і стандартних реквізитів
   тієї ж таблиці; носій скоупу додається першим автоматично; поліморфний
   реквізит дає обидві колонки пари. Неунікальний btree; індекс, покритий
   префіксом іншого, відкидає наявний `materializeIndexes`.
5. **`publicRead: "authenticated" | "anon"`** — на видах із
   `rowLevelSecurity: "enabled"`; **`project.storageBuckets: [{ bucket,
   scopeKind }]`** — бакет унікальний, вид скоупу існує. Обидва — лише
   декларація й валідація плюс контракти (`contracts.publicRead`,
   `contracts.storageBuckets`); політики генерує П3.
6. **`EventSubscription` — вид без сховища** (як `Enumeration`:
   `materializes: "none"`, `writePattern: "none"`, `scope: "absent"`,
   `referenceable: false`), тека `event-subscriptions/`, файл на підписку:
   `id`, `name`, `physicalName` (база імені тригера П3, призначене раз),
   `title?`, `description?`, `sources` (≥1: `MetadataRef` | `{ providerTable:
   "<схема>.<таблиця>" }`), `event` ∈ {`beforeWrite`, `onWrite`,
   `beforeDelete`, `onDelete`}, `whenChanged?` (≥1, логічні імена реквізитів
   і стандартних реквізитів кожного джерела-об'єкта або колонки пресету для
   таблиці провайдера; з подіями видалення — помилка), `handler: { schema?,
   name }`. *Чому вид, а не масив у проєкті:* 1С моделює підписки окремим
   об'єктом метаданих; вид дає ідентичність, `rename`, `delete`, `explain`
   даром, а реєстр уже тримає вид без сховища.
7. **Пресет джерел провайдера — константа T0** поруч із
   `DATABASE_PROVIDERS`: `PROVIDER_EVENT_SOURCES: Record<DatabaseProvider,
   readonly { schema; table; columns: readonly string[] }[]>`; для
   `supabase` — `auth.users` і `storage.objects` з колонками, взятими з
   образу локального стеку. T1 не імпортує пресет T2; тест T2 доводить, що
   кожне джерело лежить на поверхні тригерів `SUPABASE_SURFACES`.
8. **Обробник підписки** — функція без аргументів `RETURNS trigger` у
   закритій оболонці (рішення 9), будь-де в `.sql`; перевірка — стадія 5.
9. **Закрита оболонка функції (П2):** `LANGUAGE sql | plpgsql`, явна
   волатильність, `SECURITY DEFINER` ⇒ `SET search_path = ''`. Модуль виду
   1С (факт реєстру `sqlModule: "closed"`) приймає лише функції в оболонці
   без перевантажень (ім'я унікальне серед функцій схеми) і правила рядка;
   решта класів — `sql.statement-not-allowed` з підказкою властивості, що
   заміщує. Модуль `CustomTable`/`PgEnum` (`sqlModule: "debt"`) і спільні
   `metadata/sql/` — борг: дозволені всі нинішні класи, перевантаження теж.
   Динамічний SQL, перевірка викликача, `EXECUTE` — поза планом.
10. **Правило рядка** — новий клас `rowRule`: `ALTER TABLE <таблиця> ADD
    CONSTRAINT <ім'я> CHECK (<правило>)`, рівно одна підкоманда, ім'я
    обов'язкове. Лише в модулі виду і лише на таблиці свого об'єкта
    (`origin.objectId`). Граматика (до вкладення): `AND`/`OR`/`NOT`/дужки
    над атомами `<колонка> IS [NOT] NULL`; `<колонка> = | <> <літерал>`;
    `<колонка> IN (<літерали>)`; `<колонка> <оп> <колонка>` одного типу
    знімка (`=`, `<>`, `<`, `<=`, `>`, `>=`); `num_nonnulls(<колонки>) <оп>
    <ціле>`; колонки — некваліфіковані колонки цієї таблиці; без приведень,
    функцій (крім `num_nonnulls`), підзапитів. Прийняте правило — CHECK
    таблиці у фізичному знімку з `origin: { rowRule: { file } }`, а не
    SQL-одиниця (одна правда про таблицю, без шуму звірки й зайвого ребра);
    збіг імені з іншим CHECK таблиці — діагностика; `explain` показує
    походження; порівняння каталогу (`catalogFromSnapshot`) походження не
    бачить.
11. **Функції множини скоупу** (стадія 5, `checkSetFunctions`): додатково
    `LANGUAGE sql`, `SECURITY DEFINER`, `SET search_path = ''` і кожне
    відношення в тілі кваліфіковане схемою (тіло `LANGUAGE sql` розбирається
    libpg-query; нерозбірне тіло — без цієї перевірки, його ловить тінь).
12. **Ратчет боргу:** `metadata/sql-debt.json` = `{ "$schema"?, "units":
    [<ідентичність>…] }`, відсортований і без дублів. Борг — дослівна
    одиниця у модулі `sqlModule: "debt"` чи в спільному `metadata/sql/`,
    що не є функцією в закритій оболонці. Такої одиниці немає в переліку —
    `sql.debt-grows`; відсутній файл = порожній перелік. Пише перелік лише
    `introspect` (зворотна генерація: повний перелік боргу розкладених
    файлів); `fix` лише прибирає записи, яких немає серед одиниць, ніколи не
    додає.
13. **Контракт підписок:** `contracts.eventSubscriptions: { subscriptionId;
    name: string /* physicalName */; sources: { schema; table }[]; event;
    whenChanged: string[] /* фізичні колонки */; handler: { schema; name }
    }[]` — П3 генерує тригери з нього.
14. **Модулі виду й правило рядка в `explain`:** таблиці отримують
    `checks: { name; expression; origin: "kind" | "rowRule" }[]`.

## Review Focus

1. **`pattern`, який компілює JS, але відхиляє Postgres** (POSIX ARE ≠
   ECMAScript) — статична відмова для відомих розбіжностей і DB-тест, що
   прийняті компілятором вирази розгортаються в тінь (задача 3).
2. **`uniqueWithin: "parent"` на верхньому рівні ієрархії** — два елементи
   з однаковим значенням і `parent IS NULL` порушують унікальність
   (`NULLS NOT DISTINCT`) — задача 2, DB-тест.
3. **Підписка з джерелом, якого вже немає** (`delete` довідника) — `delete`
   звітує залежну підписку, а не лишає зламане посилання (задача 6).
4. **Модуль виду з `CREATE TRIGGER`, перенесений у спільний
   `metadata/sql/`,** — не проходить як `sql.debt-grows` (задача 10).
5. **`fix` на теці з `sql.debt-grows`** не додає одиницю в перелік (задача
   10).

---

### Task 0: Звірка плану з кодом і базова лінія

**Files:** — (лише читання)

- [ ] **Step 1: Передумови й якори**

Run: `git log --oneline | head -30` — коміти плану 2a й docs-коміт правок
спек є; `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-07-promotion-2b-frame-properties-closed-module.md`
Expected: якори існують, крім `Create`. Інакше — стоп і звіт.

- [ ] **Step 2: Базова лінія**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`,
`pnpm metadata:check`, `pnpm test:db`
Expected: зелено.

---

### Task 1: Значення заповнення `fill` і `empty`

**Files:**
- Modify: `packages/simetra/src/model/schemas/value-type.ts` (`DefaultValue`, `refineValueType`)
- Modify: `packages/simetra/src/model/schemas/attribute.ts`, `constant.ts` (тип `defaultValue`)
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`StandardColumnDef.defaultValue: DefaultValue`)
- Modify: `packages/simetra/src/model/schemas/rules.ts`
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`defaultOf`)
- Modify: `packages/simetra/src/compiler/stages/identity.ts` / `integrity.ts` (резолв і перевірка енам-значення — лише для скалярного `defaultValue`)
- Test: `packages/simetra/src/model/__tests__/value-type.test.ts`, `packages/simetra/src/compiler/__tests__/stage-model.test.ts`

**Interfaces:**
- Produces: `type DefaultValue = string | number | boolean | { fill: "now" | "today" | "newUuid" } | { empty: true | "object" | "array" }`;
  правила `type.default-fill-mismatch`, `type.default-empty-mismatch` (params
  `{ expected }` — форма, яку слід ужити).

- [ ] **Step 1: Failing tests**

`value-type.test.ts` (хелпер `defaultRules` наявний):

```ts
it.each([
  [{ type: "DateTime", defaultValue: { fill: "now" } }, []],
  [{ type: "Date", defaultValue: { fill: "today" } }, []],
  [{ type: "UUID", defaultValue: { fill: "newUuid" } }, []],
  [{ type: "Date", defaultValue: { fill: "now" } }, ["type.default-fill-mismatch"]],
  [{ type: "DateTime", array: true, defaultValue: { fill: "now" } }, ["type.default-fill-mismatch"]],
  [{ type: "String", length: 5, array: true, defaultValue: { empty: true } }, []],
  [{ type: "Json", defaultValue: { empty: "array" } }, []],
  [{ type: "Json", defaultValue: { empty: true } }, ["type.default-empty-mismatch"]],
  [{ type: "Integer", defaultValue: { empty: "object" } }, ["type.default-empty-mismatch"]],
])("default form %j", (input, expected) => expect(defaultRules(input)).toEqual(expected))
```

`stage-model.test.ts`: колонки отримують `default` рівно `now()`,
`(now() AT TIME ZONE 'Europe/Kyiv')::date` (проєкт з `timezone:
"Europe/Kyiv"`), `gen_random_uuid()`, `'{}'`, `'{}'::jsonb`, `'[]'::jsonb`;
константа з `{ fill: "today" }` — так само.

Run: `pnpm --filter simetra test value-type stage-model`
Expected: FAIL.

- [ ] **Step 2: Реалізація**

Union у схемах; `refineValueType` перевіряє форми за рішенням 1 (наявні
скалярні правила — без змін; `type.default-not-allowed` не спрацьовує на
дозволених об'єктних формах). `defaultOf` будує вираз; пояс — літерал
`sqlLiteral(project.timezone)`. Енам-резолв стадії 2 і `checkDefaultValues`
стадії 4 ігнорують об'єктні форми.

- [ ] **Step 3: Зелено, JSON Schema, kitchen-sink**

Додати форми в kitchen-sink (різні реквізити); регенерувати JSON Schema.
Run: `pnpm --filter simetra test`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): значення заповнення fill (now|today|newUuid) і порожнє empty"
```

---

### Task 2: Унікальність `ignoreCase` і `uniqueWithin`

**Files:**
- Modify: `packages/simetra/src/model/schemas/attribute.ts`, `value-type.ts` / `rules.ts`
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`attributeField`, `addField`, `Field.uniqueWithin` → `uniqueCarrier`)
- Modify: `packages/simetra/src/compiler/stages/integrity.ts` (`uniqueWithin` — місце й вид), `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/model/__tests__/value-type.test.ts`, `packages/simetra/src/compiler/__tests__/stage-model.test.ts`, `stage-integrity.test.ts`; DB: `packages/simetra/test/db/` (Create: `unique-within.db.test.ts`)

**Interfaces:**
- Produces: `unique: boolean | "ignoreCase"` (default `false`);
  `uniqueWithin?: "owner" | "parent"`; правила `type.unique-ignore-case-type`
  (схема), `attribute.unique-within-requires-unique` (схема),
  `attribute.unique-within-place` (стадія 4: ТЧ або вид без стандартної
  колонки `owner`/`parent`).

- [ ] **Step 1: Failing tests**

```ts
it("ignoreCase unique is a unique index on lower(column) after the scope carrier", async () => {
  // скоуплений довідник, attribute("code", { type: "String", length: 20, unique: "ignoreCase" })
  expect(tableOf(physical, "item").indexes).toContainEqual(expect.objectContaining({
    unique: true, keys: [{ column: "org_id" }, { expression: "lower(code)" }],
  }))
})
it("uniqueWithin owner keys by the owner column", …)          // підлеглий довідник: uniques містить [scope?, "owner_id", "code"]
it("uniqueWithin parent is NULLS NOT DISTINCT", …)            // ієрархічний довідник: nullsNotDistinct: true
it("uniqueWithin on a tabular section attribute is an error", …)
it("uniqueWithin owner on a catalog without owners is an error", …)
```

DB-тест (`unique-within.db.test.ts`, за зразком наявних `*.db.test.ts`):
розгорнути рендер ієрархічного довідника з `uniqueWithin: "parent"` у
тимчасову схему й переконатися, що два рядки з тим самим кодом і `parent_id
IS NULL` дають `unique_violation`.

Run: `pnpm --filter simetra test value-type stage-model stage-integrity`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 2.

- [ ] **Step 3: Зелено, kitchen-sink, JSON Schema**

Run: `pnpm --filter simetra test`, `pnpm test:db`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): унікальність без регістру й у межах власника чи батька"
```

---

### Task 3: Межі числа й формат рядка

**Files:**
- Modify: `packages/simetra/src/model/schemas/attribute.ts`, `value-type.ts`, `rules.ts`
- Modify: `packages/simetra/src/compiler/stages/model.ts` (CHECK `bounds`, `format`)
- Test: `packages/simetra/src/model/__tests__/value-type.test.ts`, `packages/simetra/src/compiler/__tests__/stage-model.test.ts`; DB: `packages/simetra/test/db/` (Create: `value-checks.db.test.ts`)

**Interfaces:**
- Produces: поля реквізиту `nonNegative?: true`, `positive?: true`,
  `minValue?: number | string`, `maxValue?: number | string`, `pattern?:
  string`, `minLength?: number`; правила `type.bound-type`,
  `type.bound-conflict`, `type.bound-order`, `type.bound-invalid`,
  `type.format-type`, `type.pattern-invalid`.

- [ ] **Step 1: Failing tests**

```ts
it("numeric bounds form one CHECK", async () => {
  // attribute("qty", { type: "Numeric", precision: 10, scale: 2, nonNegative: true, maxValue: "1000" })
  expect(checks).toContainEqual({ name: "item_qty_bounds", expression: "qty >= 0 AND qty <= 1000" })
})
it("pattern and minLength form one CHECK", async () => {
  expect(checks).toContainEqual({ name: "item_code_format", expression: "code ~ '^[A-Z]+$' AND char_length(code) >= 2" })
})
```

Схемні: `positive` + `nonNegative` → `type.bound-conflict`; `minValue >
maxValue` → `type.bound-order`; `pattern` на `Integer` → `type.format-type`;
`pattern: "("`, `"(?<name>x)"`, `"\\p{L}"`, `"\\k<a>"` →
`type.pattern-invalid` (вираз мусить компілюватися `new RegExp(p, "u")` і
не містити іменованих груп, `\p{…}`/`\P{…}` і `\k<…>` — конструкцій JS, яких
регулярні вирази Postgres не знають); межі на `array` → `type.bound-type`.
DB-тест (`value-checks.db.test.ts`): модель із `pattern` `"^[A-Z]{2,}\\d*$"`
і межами розгортається в тимчасову схему стеку, і рядок, що порушує
формат, дає `check_violation`.

Run: `pnpm --filter simetra test value-type stage-model`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 3; літерали — через
`sqlLiteral`, колонки — через `quoteIdent`.

- [ ] **Step 3: Зелено, kitchen-sink, JSON Schema**

Run: `pnpm --filter simetra test`, `pnpm test:db`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): межі числа й формат рядка — CHECK колонки з властивостей реквізиту"
```

---

### Task 4: Складені індекси `indexes`

**Files:**
- Modify: `packages/simetra/src/model/schemas/catalog.ts`, `document.ts`, `tabular-section.ts`
- Modify: `packages/simetra/src/model/kinds/standard.ts`, `catalog.ts`, `document.ts` (факт `compositeIndexes: true`)
- Modify: `packages/simetra/src/compiler/stages/model.ts` (індекси в `derivedIndexes` з `order`)
- Modify: `packages/simetra/src/compiler/stages/integrity.ts`, `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-model.test.ts`, `stage-integrity.test.ts`

**Interfaces:**
- Produces: `indexes: { attributes: (string | { name: string; order: "desc" })[] }[]`
  (default `[]`); правила `index.attribute-unknown`, `index.attribute-duplicate`.

- [ ] **Step 1: Failing tests**

```ts
it("composite index puts the scope carrier first and keeps desc order", async () => {
  // скоуплений документ: indexes: [{ attributes: ["counterparty", { name: "date", order: "desc" }] }]
  expect(tableOf(physical, "sale").indexes).toContainEqual(expect.objectContaining({
    unique: false, keys: [{ column: "org_id" }, { column: "counterparty_id" }, { column: "date", order: "desc" }],
  }))
})
it("tabular section index uses the section's own attributes", …)
it("unknown or repeated attribute in an index is an error", …)
it("an index covered by a longer one is dropped", …)
```

Run: `pnpm --filter simetra test stage-model stage-integrity`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 4; ім'я індексу — тим самим
механізмом імен, що й наявні похідні індекси.

- [ ] **Step 3: Зелено, kitchen-sink, JSON Schema**

Run: `pnpm --filter simetra test`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): складені індекси indexes з реквізитів своєї таблиці"
```

---

### Task 5: `publicRead` і `storageBuckets`

**Files:**
- Modify: схеми видів із `rowLevelSecurity: "enabled"` (`catalog.ts`, `document.ts`, `constant.ts`, `information-register.ts`, `accumulation-register.ts`), `project.ts`
- Modify: `packages/simetra/src/compiler/stages/identity.ts` (резолв `storageBuckets[].scopeKind`), `integrity.ts`
- Modify: `packages/simetra/src/compiler/contracts.ts`
- Test: `packages/simetra/src/model/__tests__/kind-schemas.test.ts`, `packages/simetra/src/compiler/__tests__/contracts.test.ts`, `stage-scope-identity.test.ts`

**Interfaces:**
- Produces: `publicRead?: "authenticated" | "anon"`;
  `project.storageBuckets: { bucket: string; scopeKind: string }[]` (default `[]`);
  `Contracts.publicRead: { objectId: string; role: "authenticated" | "anon" }[]`;
  `Contracts.storageBuckets: { bucket: string; scopeKindId: string }[]`;
  правила `storage.bucket-duplicate`, `storage.scope-kind-unknown`.

- [ ] **Step 1: Failing tests**

```ts
it("publicRead is a field exactly of kinds with row level security", () => {
  for (const kind of METADATA_KINDS)
    expect(Object.keys(unwrap(KIND_REGISTRY[kind].schema).shape).includes("publicRead"))
      .toBe(KIND_REGISTRY[kind].rowLevelSecurity === "enabled")
})
it("contracts carry publicRead and storage buckets", …)
it("bucket with an unknown scope kind or a repeated bucket is an error", …)
```

Run: `pnpm --filter simetra test kind-schemas contracts stage-scope-identity`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 5.

- [ ] **Step 3: Зелено, kitchen-sink, JSON Schema**

Run: `pnpm --filter simetra test`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): publicRead видів із RLS і декларація бакетів сховища"
```

---

### Task 6: Вид `EventSubscription` і пресет джерел провайдера

**Files:**
- Create: `packages/simetra/src/model/schemas/event-subscription.ts`
- Create: `packages/simetra/src/model/kinds/event-subscription.ts`
- Modify: `packages/simetra/src/model/schemas/metadata-kind.ts` (`METADATA_KINDS`), `schemas/index.ts`, `kinds/registry.ts`
- Modify: `packages/simetra/src/model/schemas/project.ts` (`PROVIDER_EVENT_SOURCES`)
- Modify: `packages/simetra/src/compiler/stages/identity.ts` (ролі посилань `eventSubscription.source`), `integrity.ts` (джерела, `whenChanged`), `links.ts` (обробник), `contracts.ts` (`eventSubscriptions`), `diagnostics.ts`, `messages.ts`
- Modify: `packages/simetra/src/compiler/codegen.ts`, `presentation.ts`, `explain.ts` — лише якщо вид без таблиці й без значень їх ламає (рішення — з факту реєстру, не з імені виду)
- Create: `packages/simetra/schemas/event-subscriptions.schema.json` (регенерація)
- Test: `packages/simetra/src/compiler/__tests__/event-subscriptions.test.ts` (Create), `operations-delete.test.ts`, `operations-rename.test.ts`; T2: `packages/simetra/src/schema/__tests__/provider-event-sources.test.ts` (Create); DB: `packages/simetra/test/db/provider-event-sources.db.test.ts` (Create)

**Interfaces:**
- Produces:
  - Схема за рішенням 6 (лише потрібні поля шапки: `$schema`, `id`, `kind`,
    `name`, `physicalName`, `title`, `description`; без `schema`/`scope`).
  - `PROVIDER_EVENT_SOURCES` за рішенням 7.
  - `Contracts.eventSubscriptions` за рішенням 13.
  - Правила: `subscription.source-not-table` (джерело-об'єкт без таблиці),
    `subscription.provider-table-unknown`, `subscription.when-changed-unknown`,
    `subscription.when-changed-on-delete`, `subscription.handler-missing`,
    `subscription.handler-signature` (аргументи або не `RETURNS trigger`).

- [ ] **Step 1: Колонки пресету з образу**

Запит до стеку тим самим підключенням, що в
`packages/simetra/test/db/*.db.test.ts`: `select table_schema, table_name,
column_name from information_schema.columns where (table_schema, table_name)
in (('auth','users'), ('storage','objects')) order by 1, 2,
ordinal_position`. Перелік — у `PROVIDER_EVENT_SOURCES.supabase` у порядку
`ordinal_position`; той самий запит стає DB-тестом кроку 2.

- [ ] **Step 2: Failing tests**

`event-subscriptions.test.ts`:

```ts
it("a subscription on a catalog compiles into a trigger contract", async () => {
  // EventSubscription "StampContract": sources [{ kind: "Catalog", name: "Contract" }],
  // event "beforeWrite", whenChanged ["number"], handler { schema: "app", name: "stamp" };
  // sql/app/stamp.sql: CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ … $$;
  expect(result.model!.contracts.eventSubscriptions).toEqual([{
    subscriptionId: uuid(…), name: "stamp_contract", sources: [{ schema: "public", table: "contract" }],
    event: "beforeWrite", whenChanged: ["number"], handler: { schema: "app", name: "stamp" },
  }])
})
it("provider table source must be in the provider preset", …)        // { providerTable: "auth.sessions" } → subscription.provider-table-unknown
it("whenChanged names an attribute of every source", …)
it("whenChanged with a delete event is an error", …)
it("handler must exist, take no arguments and return trigger", …)
it("a subscription on an enumeration is an error", …)                // subscription.source-not-table
```

`operations-delete.test.ts`: видалення довідника-джерела звітує залежну
підписку. `operations-rename.test.ts`: перейменування довідника переписує
`sources` підписки.
`provider-event-sources.test.ts` (T2): кожне джерело
`PROVIDER_EVENT_SOURCES.supabase` збігається з поверхнею тригерів
`SUPABASE_SURFACES`.
`provider-event-sources.db.test.ts`: колонки пресету = колонки стеку.

Run: `pnpm --filter simetra test event-subscriptions operations-delete operations-rename provider-event-sources`
Expected: FAIL.

- [ ] **Step 3: Реалізація**

Запис реєстру за рішенням 6 (`references(obj)` повертає джерела-об'єкти —
так `rename` і `delete` бачать їх даром); перевірки стадій 4–5 і контракт.
Обробник — функціональна одиниця з ідентичністю `functionIdentity(schema,
name, [])`; тип повернення — з дерева розбору, як у `signatureProblem`.

- [ ] **Step 4: Зелено, kitchen-sink, JSON Schema**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`, `pnpm test:db`
Expected: PASS.

- [ ] **Step 5: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): вид EventSubscription — декларація й валідація підписок, пресет джерел провайдера"
```

---

### Task 7: Модуль виду — лише закриті форми; закрита оболонка функції

**Files:**
- Modify: `packages/simetra/src/model/kinds/standard.ts` і записи всіх видів (факт `sqlModule: "closed" | "debt"`)
- Create: `packages/simetra/src/compiler/sql/closed-forms.ts`
- Modify: `packages/simetra/src/compiler/pipeline.ts` (виклик перевірки модулів після `readSqlUnits`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/closed-forms.test.ts` (Create)

**Interfaces:**
- Produces:
  - `closedShellProblem(tree: Node): "language" | "volatility" | "searchPath" | undefined`
    — для `CreateFunctionStmt` (не процедури).
  - `checkSqlModules(objects: readonly ParsedObject[], units: readonly VerbatimUnit[]): Diagnostic[]`
    — модуль виду з фактом `closed`: клас поза {`function`, `rowRule`} →
    `sql.statement-not-allowed` з `detail: "kindModule"` і `params.class`
    (підказка за класом: `trigger` → `EventSubscription`, `policy` →
    `publicRead` / права (П3), `grant`/`defaultPrivileges` → виводяться з
    виду, `comment` → `description`, `view`/`materializedView` → віртуальні
    таблиці чи RPC читання, `sequence` → нумерація, `extension` → профіль
    провайдера, `domain` → логічні типи, решта — загальна); функція з
    `closedShellProblem` → `sql.closed-shell` (params `{ problem }`);
    перевантаження функції модуля виду → `sql.function-overload`.

- [ ] **Step 1: Failing tests**

```ts
const SALE_SQL = "documents/Sale/Sale.sql"
it.each([
  ["CREATE TRIGGER t BEFORE INSERT ON public.sale FOR EACH ROW EXECUTE FUNCTION public.f();", "trigger"],
  ["CREATE POLICY p ON public.sale USING (true);", "policy"],
  ["COMMENT ON TABLE public.sale IS 'x';", "comment"],
  ["CREATE VIEW public.v AS SELECT 1;", "view"],
])("kind module rejects %s", async (sql, cls) => { /* sql.statement-not-allowed, detail kindModule, params.class === cls */ })
it("custom table module keeps verbatim classes (debt)", …)          // той самий тригер у custom-tables/T/T.sql — без sql.statement-not-allowed (борг — задача 10)
it.each([
  ["LANGUAGE c", "language"],
  ["no volatility", "volatility"],
  ["SECURITY DEFINER without SET search_path = ''", "searchPath"],
])("closed shell: %s", …)
it("overload in a kind module is an error, in a custom table module is not", …)
it("movement query blocks of a document module stay valid", …)
```

Run: `pnpm --filter simetra test closed-forms`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 9; вид власника одиниці — за
`ownerFile` через `stage1.objects`; факт — `KIND_REGISTRY[kind].sqlModule`.

- [ ] **Step 3: Зелено**

Run: `pnpm --filter simetra test`, `pnpm metadata:check`
Expected: PASS (модуль документа прикладу містить лише блок рухів).

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra
git commit -m "feat(compiler): модуль виду 1С — лише закриті форми, закрита оболонка функції"
```

---

### Task 8: Правило рядка — граматика й CHECK у знімку

**Files:**
- Modify: `packages/simetra/src/model/physical/catalog.ts` (клас `rowRule` у `SqlUnitClass`; `catalogFromSnapshot` не переносить походження CHECK)
- Modify: `packages/simetra/src/model/physical/snapshot.ts` (`checks[].origin?: { rowRule: { file: string } }`)
- Modify: `packages/simetra/src/compiler/sql/units.ts` (`classify`: `AlterTableStmt` з однією `AT_AddConstraint` типу CHECK → `rowRule`, ідентичність `<схема>.<таблиця>.<ім'я>`; без імені — `sql.statement-not-allowed`, `detail: "rowRuleName"`)
- Create: `packages/simetra/src/compiler/sql/row-rule.ts`
- Modify: `packages/simetra/src/compiler/pipeline.ts` (вкладення правил у знімок після `readSqlUnits`, до стадії 4; одиниця `rowRule` не йде в `sqlUnits`)
- Modify: `packages/simetra/src/compiler/explain.ts` (рішення 14)
- Modify: `packages/simetra/src/schema/reverse/units.ts` — лише якщо новий клас вимагає запису в `SIDECAR_ORDER`/`SIGNED`/`NAMED` для вичерпності типів
- Test: `packages/simetra/src/compiler/__tests__/row-rule.test.ts` (Create), `explain.test.ts`, `packages/simetra/src/model/__tests__/catalog-model.test.ts`

**Interfaces:**
- Produces: `rowRuleProblem(expr: Node, columns: ReadonlyMap<string, string>): string | undefined`
  (ключ — фізичне ім'я колонки таблиці, значення — її тип знімка; повертає
  назву забороненої конструкції); правила `sql.row-rule-grammar` (params
  `{ construct }`), `sql.row-rule-foreign-table`, `sql.row-rule-outside-module`,
  `sql.row-rule-name-taken`.

- [ ] **Step 1: Failing tests**

`row-rule.test.ts` (модуль документа `documents/Sale/Sale.sql`):

```ts
it("a valid row rule becomes a table CHECK with its origin, not a unit", async () => {
  const sql = "ALTER TABLE public.sale ADD CONSTRAINT sale_one_party CHECK (num_nonnulls(buyer_id, seller_id) <= 1);"
  const sale = tableOf(model.physical, "sale")
  expect(sale.checks).toContainEqual({ name: "sale_one_party", expression: "num_nonnulls(buyer_id, seller_id) <= 1", origin: { rowRule: { file: "documents/Sale/Sale.sql" } } })
  expect(model.sqlUnits.map((u) => u.class)).not.toContain("rowRule")
})
it.each([
  ["lower(code) = 'x'", "FuncCall"],
  ["code = (SELECT 1)", "SubLink"],
  ["code = 'x'::text", "TypeCast"],
  ["other.code IS NULL", "qualified column"],
  ["amount > code", "column type mismatch"],
  ["missing IS NULL", "unknown column"],
])("grammar rejects %s", …)
it("row rule on another object's table is an error", …)
it("row rule in a shared sql file is an error", …)
it("row rule name equal to a derived CHECK is an error", …)
```

`explain.test.ts`: таблиця показує CHECK з `origin: "rowRule"`.
`catalog-model.test.ts`: каталог зі знімка з правилом рядка дорівнює
каталогу без походження (немає хибної різниці).

Run: `pnpm --filter simetra test row-rule explain catalog-model`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 10; обхід дерева — рекурсивний
за зразком `sideEffectOf` у `stages/links.ts`, але білим списком вузлів.

- [ ] **Step 3: Зелено**

Run: `pnpm --filter simetra test`, `pnpm test:db`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra
git commit -m "feat(compiler): правило рядка модуля виду — закрита граматика, CHECK таблиці у знімку"
```

---

### Task 9: Функції множини скоупу — закрита форма

**Files:**
- Modify: `packages/simetra/src/compiler/stages/links.ts` (`checkSetFunctions`, `signatureProblem`)
- Modify: `packages/simetra/src/compiler/messages.ts`
- Modify: `packages/simetra/src/compiler/__tests__/helpers.ts` (фікстурна функція множини: `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::uuid $$`)
- Test: `packages/simetra/src/compiler/__tests__/stage-links.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it.each([
  ["LANGUAGE plpgsql", "language"],
  ["without SECURITY DEFINER", "security"],
  ["without SET search_path = ''", "searchPath"],
  ["unqualified relation in the body: SELECT m.org_id FROM org_member m", "unqualified"],
])("set function: %s", …)   // scope.set-function-signature з params.reason
it("set function with qualified relations passes", …)
```

Run: `pnpm --filter simetra test stage-links`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 11; причини — значення
`params.reason` наявного правила `scope.set-function-signature`; тексти
`unqualified` — «with an empty search_path an unqualified relation does not
resolve».

- [ ] **Step 3: Зелено**

Run: `pnpm --filter simetra test`, `pnpm metadata:check`
Expected: PASS (функції прикладу вже в цій формі).

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): функція множини скоупу — SECURITY DEFINER, порожній search_path, кваліфіковані відношення"
```

---

### Task 10: Ратчет боргу `sql-debt.json`

**Files:**
- Create: `packages/simetra/src/model/schemas/sql-debt.ts` (`sqlDebtSchema`, `SQL_DEBT_FILE = "sql-debt.json"`)
- Modify: `packages/simetra/src/compiler/stages/files.ts` (стадія 1 читає файл)
- Create: `packages/simetra/src/compiler/sql/debt.ts`
- Modify: `packages/simetra/src/compiler/pipeline.ts`, `diagnostics.ts`, `messages.ts`
- Modify: `packages/simetra/src/compiler/json-schema.ts` (`sql-debt.schema.json`)
- Modify: `packages/simetra/src/schema/reverse/generate.ts` (пише перелік)
- Modify: `packages/simetra/src/compiler/operations/fix.ts` (лише прибирає)
- Test: `packages/simetra/src/compiler/__tests__/sql-debt.test.ts` (Create), `operations-fix.test.ts`, `packages/simetra/src/schema/__tests__/reverse-generate.test.ts`

**Interfaces:**
- Produces:
  - `sqlDebtSchema = z.strictObject({ $schema: z.string().optional(), units: z.array(z.string()) })`;
    невідсортований чи з дублями — `debt.not-canonical`.
  - `debtUnits(units: readonly VerbatimUnit[], objects: readonly ParsedObject[]): string[]`
    — ідентичності одиниць боргу (рішення 12), відсортовані.
  - Правило `sql.debt-grows` (params `{ identity }`, file/line одиниці).
  - Зворотна генерація: `sql-debt.json` з `debtUnits` розкладених файлів
    (пише завжди, зокрема `units: []`).
  - `fix`: `units` ∩ поточний борг; файла немає — не створює.

- [ ] **Step 1: Failing tests**

```ts
it("a debt unit missing from sql-debt.json is an error", async () => {
  // custom-tables/T/T.sql з CREATE POLICY; sql-debt.json без неї → sql.debt-grows
})
it("a listed debt unit compiles", …)
it("moving a trigger from a kind module to a shared file is debt growth", …)
it("functions in the closed shell are never debt", …)
it("unsorted sql-debt.json is not canonical", …)
```

`operations-fix.test.ts`:

```ts
it("fix drops stale debt entries and never adds new ones", async () => {
  // перелік ["policy:public.t.gone", "policy:public.t.p"], на диску лише p і нова q
  // після fix: ["policy:public.t.p"]; компіляція далі звітує sql.debt-grows для q
})
```

`reverse-generate.test.ts`: прийнята таблиця з політикою й тригером дає
`sql-debt.json` з обома ідентичностями; функція в оболонці — не в
переліку.

Run: `pnpm --filter simetra test sql-debt operations-fix reverse-generate`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 12; «функція в закритій
оболонці» — `closedShellProblem` із задачі 7.

- [ ] **Step 3: Зелено, JSON Schema, DB**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`, `pnpm test:db`
Expected: PASS (round-trip DB-тести designer тепер отримують
`sql-debt.json` від `introspect`; інша різниця — стоп і звіт).

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra packages/designer
git commit -m "feat(compiler): ратчет боргу дослівного SQL — перелік sql-debt.json, introspect пише, fix лише звужує"
```

---

### Task 11: Скіли designer, приклад, гейти

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (нові властивості реквізиту й об'єкта, вид `EventSubscription`, закриті форми модуля, правило рядка; приклади — короткі форми з плейсхолдерами)
- Modify: `packages/designer/skills/simetra-adoption/SKILL.md` (`sql-debt.json`: що пише `introspect`, чому ратчет лише зменшується)
- Modify: `packages/designer/src/__tests__/skill-examples.test.ts` — лише якщо нові приклади скілу мають компілюватися

- [ ] **Step 1: Скіли** — правки за переліком; приклади в скілі компілюються
тестом `skill-examples`.

- [ ] **Step 2: Повні гейти**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
`pnpm metadata:check`, `pnpm test:db`, `python3 scripts/check-doc-anchors.py`
Expected: усе зелене.

- [ ] **Step 3: Коміт**

```bash
git add packages/designer/skills packages/designer/src/__tests__
git commit -m "docs(designer): скіли — властивості рамки, підписки, закритий модуль, борг SQL"
```
