# П2, план C3 — уточнення фізики моделі за дослідженням 1С і Postgres: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** фізичний знімок і контракти компілятора набувають остаточної форми
моделі (М17–М22): порожній вимір — `NULL`, ключі похідних таблиць —
`UNIQUE NULLS NOT DISTINCT`, стандартні реквізити `version` і
`predefined_name`, обов'язковість за видом, місячні обороти регістрів
накопичення, нумерація першим записом із генерованою колонкою періоду,
контракт оболонки `save`/`post`/`unpost`. Усе — T0/T1, чиста функція без бази;
ратчет, хеш і JSON Schema D1 будуються вже на цій формі.

**Архітектура:** факти виду — у реєстрі видів T0 (`RegisterKeySpec`,
`NumberingSpec`, `requiredOnPost`, нові стандартні колонки); стадія 3
(`compiler/stages/model.ts`) будує з них таблиці, ключі й генеровані колонки,
не розгалужуючись за іменем виду; контракти (`compiler/contracts.ts`)
читають ті самі факти. SQL тригерів, оболонки й віртуальних таблиць — П3;
рендер DDL — крок 8 П2.

**Технології:** TypeScript 7, Zod 4, Vitest 5 — як у планах B–C2. Нових
залежностей немає. `compile()` у C3 ще синхронний (асинхронним його робить D1).

**Спека:** джерело — коміт `754f54b` плюс відповіді архітектора спеки на
розвилки плану, внесені в спеку комітом `ec70277` (прихід і витрата в
місячних оборотах, вираз періоду в поясі проєкту, унікальність номера,
предвизначені в межах скоупу; D1 без застарілих формулювань):

- [спека «Платформа в Postgres»](../specs/2026-10-01-platform-in-postgres-design.md)
  §2 (М17–М23), §4 «Модель даних», §5 «Документ», §6 «Регістри»;
- [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) §2
  (М17–М23), §5 (стандартні реквізити, порожнє значення й обов'язковість,
  нумерація), §7 (оболонка, регістр накопичення, ключі й індекси, віртуальні
  таблиці), §8.3 (контракти в знімку), §11 крок 6а, §13;
- [платформна спека](../specs/2026-09-24-simetra-platform-design.md) §4
  (Р22, Р24–Р26);
- критерії рев'ю — `.agents/skills/code-review/references/simetra-domain-criteria.md`
  (рядки Р22, Р24/Р25, Р26).

**Серія планів П2:** A, B, C1, C2 (виконано) → **C3** (цей) → D1
([план](2026-09-30-p2d1-compiler-core.md); його задача 7 після C3 лишає лише
блок представлення й звірку) → D2 → E. Статус — [ROADMAP](../../ROADMAP.md),
Віха 1.

## Рішення плану (узгоджено з архітектором спеки)

1. **Місячні обороти регістра залишків** зберігають на кожен ресурс пару
   `<r>_receipt` і `<r>_expense` (`NOT NULL DEFAULT 0`), нетто — їхня
   різниця; оборотного — один `<r>`. Так `balanceAndTurnovers` бере цілі
   місяці з таблиці. «Нульовий рядок» — усі колонки ресурсів нуль (видаляє
   тригер П3).
2. **Період номера** — стандартний реквізит `numberPeriod` ↔ `number_period`
   типу `date`, генерована колонка (завжди `STORED`) з виразом
   `date_trunc('<unit>', ("date" AT TIME ZONE '<timezone>'))::date`; лише
   коли `numberPeriodicity ≠ "None"`. Форма `date_trunc(…, '<tz>')::date`
   **не годиться**: `timestamptz::date` приводить у поясі сесії. Той самий
   вираз (з `period` і `month`) — для місяця в контракті місячних оборотів.
   Чи приймає Postgres вираз як генерований — перевіряє рендер на тіні
   (крок 8), не C3.
3. **Унікальність номера документа — завжди**, незалежно від `autonumber`:
   `UNIQUE (носій, number_period, number)` при періодичності, `UNIQUE (носій,
   number)` при `None` (`NULLS DISTINCT`: порожні номери чернеток не
   конфліктують). Окремого індексу на `number` немає. Код довідника — як
   був: `UNIQUE (носій, code)` лише за `codeUnique`.
4. **C3 вводить `contracts.numbering` і `contracts.predefined` повністю**;
   D1 задача 7 лишає блок представлення й звірку (архітектор правит план D1
   сам).
5. **Межа віртуальної таблиці `balance`**: `p_at timestamptz`,
   `p_recorder_type text` (дискримінатор — `physicalName` документа),
   `p_recorder_id uuid`. Без реєстратора — `period <= p_at` включно; з
   реєстратором — рухи з `(period, recorder_type, recorder_id) < (p_at,
   p_recorder_type, p_recorder_id)`, строго до цього документа (аналог
   «Исключая» 1С). У контракті — імена й типи, семантика — у JSDoc; SQL — П3.
6. **CHECK обов'язковості документа** — звичайне обмеження таблиці в
   `PhysicalTable.checks` (рендериться в кроці 8, входить у паперовий тест) з
   іменем `chooseConstraintName(<таблиця>, <колонка>, "required", …)`;
   контракт `requiredOnPost` посилається на це ім'я й тримає мапінг
   «обмеження → реквізит».
7. **Тригер незмінності** — одне ім'я `makeObjectName(<документ>, undefined,
   "immutable")` на шапку й усі ТЧ; колізію з таблицями й функціями не
   перевіряємо: тригер живе в просторі імен своєї таблиці.
8. **Предвизначені елементи** — `{ id, name, description? }`; `id` — UUID v4,
   як у всіх елементів; `name` — за правилами імен реквізитів (стиль
   проєкту), унікальний у межах довідника; з іменами реквізитів не
   звіряється (різні простори). Окремих кодів діагностики немає:
   `identity.id-missing`, `identity.id-duplicate`, `identity.name-duplicate`,
   `identity.name-case`.
9. **Незалежний регістр відомостей** — ключ `UNIQUE NULLS NOT DISTINCT
   (носій, виміри…, period)` без PK; порядок колонок змінюється з
   `(носій, period, виміри…)` на спековий. Вироджений ключ (немає ні носія, ні
   вимірів, ні періоду) — як був: рядок-одинак із PK.
10. **Паперової фікстури в коді ще немає** (`examples/` з'явиться в кроці 9),
    тож C3 доводить форму тестами знімка.

## Трасування «пункт спеки → задача»

| Пункт спеки | Задача |
| --- | --- |
| М17: виміри nullable, `required` виміру → `NOT NULL`; ключі похідних таблиць і незалежного регістру відомостей — `UNIQUE NULLS NOT DISTINCT`; рівність — `IS [NOT] DISTINCT FROM` (лишається) | 1 (ключі рухів, регістр відомостей, конструктор), 3 (`turnovers_month`, `totals`) |
| М18: `version` у довідника й документа; `predefined_name` з частковим унікальним індексом; `predefinedItems { id, name, description? }`; `contracts.predefined` | 2 |
| М19: `required` за видом; `CHECK (NOT posted OR …)` шапки документа; ТЧ — лише перевірка оболонки | 5 |
| М20: `<reg>_turnovers_month` для обох видів, `<reg>_totals` лише для залишків; індекси рухів із реєстратором; параметри `p_at`/`p_recorder_type`/`p_recorder_id`; перерахунок і перевірка обох таблиць | 3 |
| М21: `contracts.numbering` (момент — перший запис); генерована колонка періоду; `UNIQUE (носій, період, номер)` | 4 |
| М22: контракт оболонки `save`/`post`/`unpost`; незмінність проведеного — тригер (ім'я в контракті) | 5 |
| М23: C3 перед D1; D1 задача 7 без видалення предвизначених | 6 (статус); правка плану D1 — архітектор |
| П2 §10.2: паперовий тест на новій формі | рішення 10; тести знімка в задачах 1–5 |
| Спека «Платформа в Postgres» §10: ROADMAP «C3 перед D1» | 6 |

## Global Constraints

- Усі обмеження планів B–C2 чинні: T0 — лише `zod`; T1 — без Node API;
  детермінізм (той самий вхід → побайтно той самий знімок і контракти,
  порядок за id/іменем, як зараз); UUID v4; імена похідних об'єктів —
  `makeObjectName`/`chooseConstraintName`; тексти діагностики — англійською;
  коментарі в коді — українською й пояснюють «чому».
- Без шимів: `RegisterKeySpec.dimensionsNotNull` і `dimensionsUnique`
  видаляються, а не деприкуються; старий шлях PK незалежного регістру
  відомостей і PK `totals` прибирається в тій самій задачі.
- Кожне розгалуження за видом читає реєстр видів (`AGENTS.md`); нових
  `kind === "Document"` у T1 немає.
- Стандартні реквізити не пишуться у файлах як власні (`AGENTS.md`);
  логічні імена — канонічний camelCase у реєстрі, стиль проєкту дає
  `standardLogicalName`.
- Імена: `version` ↔ `version`, `predefinedName` ↔ `predefined_name`,
  `numberPeriod` ↔ `number_period`, `month` ↔ `month`; таблиці
  `makeObjectName(<регістр>, undefined, "turnovers_month" | "totals")`;
  функції оболонки `makeObjectName(<документ>, undefined, "save" | "post" | "unpost")`.
- Вираз обрізання періоду — одне джерело в T0
  (`truncatedPeriodExpression`, задача 3); тексту `::date` над `timestamptz`
  без `AT TIME ZONE` у коді немає.
- Тести не стверджують поведінку бази (спайки спеки «Платформа в Postgres»
  §9 не виконано): лише форма знімка й контракти.
- Гейти після кожної задачі: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  під час роботи — `pnpm --filter simetra test <pattern>` (без `--` перед
  шаблоном: інакше фільтр мовчки ігнорується); після правки доків —
  `python3 scripts/check-doc-anchors.py`.
- Коміти — Conventional Commits, опис українською, без трейлерів; точково:
  `git add <явні шляхи>` і `git commit -m "<повідомлення>" --only -- <ті самі шляхи>`.
  Комітить оркестратор із дозволу власника; субагент лише стейджить.

## Review Focus

1. **Складений FK скоупу на nullable вимірі** — `(org_id, item_id) →
   item (org_id, id)` лишається, коли `item_id` став nullable (`MATCH
   SIMPLE` пропускає `NULL`; FK не має зникнути разом із `NOT NULL`). Тест —
   задача 1.
2. **Регістр накопичення зі скоупом, але без вимірів** — `turnovers_month`
   з ключем `(org_id, month)`, `totals` — одинак, якого заступає скоуп-колонка
   як PK; не порожній UNIQUE і не PK на `month`. Тести — задача 3.
3. **Документ з `numberPeriodicity: "None"` і без скоупу** — жодної колонки
   `number_period`, `UNIQUE (number)`; з `"Quarter"` — `'quarter'` у виразі.
   Тести — задача 4.
4. **Власний реквізит з іменем `version` (або `number_period` у
   `snake_case`-проєкті)** — `identity.name-reserved`, а не дубль колонки
   на стадії 4. Тести — задачі 2 і 4.
5. **`required` реквізит рядка ТЧ документа і поліморфний `required`
   реквізит шапки** — у ТЧ ні `NOT NULL`, ні CHECK, лише запис у
   `requiredOnPost.sections`; у шапки CHECK покриває обидві колонки пари.
   Тести — задача 5.

---

### Task 1: Nullable виміри й ключі `NULLS NOT DISTINCT` у рухах і регістрі відомостей (М17)

**Files:**
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`RegisterKeySpec`)
- Modify: `packages/simetra/src/model/kinds/accumulation-register.ts`, `kinds/information-register.ts` (`registerKeys`)
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`add`, `addRegisterKeys`)
- Modify: `packages/simetra/src/compiler/stages/integrity.ts` (перевірка рухів конструктора: `required`-список і `nullable`)
- Test: `packages/simetra/src/model/__tests__/kind-registry.test.ts`, `packages/simetra/src/compiler/__tests__/stage-registers.test.ts`, `stage-posting-integrity.test.ts`, `movement-functions.test.ts`, `stage-scope-model.test.ts` (оновлення очікувань ключів)

**Interfaces:**
- Consumes: `attributeField` стадії 3 (`notNull: attribute.required`), `registerSingletonOf`, `withScope` — як є.
- Produces (задача 3 розширює цей тип):
  ```ts
  export interface RegisterKeySpec {
    /** `recorder` — PK `(recorder_type, recorder_id, line_number)`; `none` — PK немає. */
    movementsPrimaryKey: "recorder" | "none"
    /** `UNIQUE NULLS NOT DISTINCT (носій, виміри…, period)` — ключ запису. */
    recordKeyUnique: boolean
    movementIndexes: boolean
    totals: boolean
    additiveResources: boolean
    virtualTables: readonly VirtualTableKind[]
  }
  ```
  Значення: регістр накопичення — `recorder`, `recordKeyUnique: false`;
  регістр відомостей підлеглий — `recorder` + `recordKeyUnique: true`;
  незалежний — `none` + `recordKeyUnique: true`. `dimensionsNotNull` і
  `dimensionsUnique` зникають.
- Фізика: колонка виміру — `NOT NULL` лише за `required` (рядок
  `built.notNull = registerKeys.dimensionsNotNull` видаляється); ключ запису
  — `uniques` з `nullsNotDistinct: true`; невироджений незалежний регістр
  відомостей PK не має; вироджений — одинак із PK, як був. Коментар про
  «PostgREST робить upsert лише за PK» у `information-register.ts` замінити
  причиною спеки §7: запис іде командою T3, PK для PostgREST не потрібен, а
  PK не допускає `NULL` у вимірі.
- Конструктор рухів: у `fields` обов'язкові лише `required` виміри,
  адитивні ресурси й `required` ресурси/реквізити; `null` дозволено в
  необов'язковий вимір. Пропущений необов'язковий вимір обгортка вже дає як
  `NULL::<тип>` (`movement-functions.ts`) — тест це закріплює.

- [ ] **Step 1: Тести**

`kind-registry.test.ts`:
- `register key specs` — точні об'єкти `registerKeys` для регістра
  залишків, оборотного, підлеглого й незалежного регістра відомостей (без
  `dimensionsNotNull`/`dimensionsUnique`).

`stage-registers.test.ts` (фікстура `stockFiles` — `warehouse` з
`required: true`, `item` без):
- `dimensions are nullable unless required` — у `stock`
  `column(t, "warehouse_id").notNull === true`, `item_id` — `false`;
  складені FK `(org_id, warehouse_id)` і `(org_id, item_id)` присутні
  (Review Focus 1);
- `independent information register key` — у `rates`: `primaryKey`
  `undefined`; `uniques` містить `{ columns: ["org_id", "currency_id", "period"], nullsNotDistinct: true }`;
  `period` — `notNull: true`; неперіодичний — `["org_id", "currency_id"]`;
- `subordinate information register` — PK `["recorder_type", "recorder_id", "line_number"]`
  і UNIQUE `["org_id", "currency_id", "period"]` з `nullsNotDistinct: true`;
- наявні тести одинака (`independent non-periodic register without dimensions or scope`)
  — без змін і зелені.

`stage-posting-integrity.test.ts`:
- `null into optional dimension` — рух `fields: { warehouse: "doc.warehouse", item: "null", qty: "1" }`
  → без помилок;
- `null into required dimension` — `warehouse: "null"` →
  `posting.type-mismatch`, pointer `/posting/movements/0/fields/warehouse`;
- `optional dimension may be omitted` — без `item` → без
  `posting.fields-incomplete`; без `warehouse` → `posting.fields-incomplete`
  з `missing: "warehouse"`.

`movement-functions.test.ts`:
- `omitted optional dimension is typed null` — тіло обгортки містить
  `NULL::uuid AS item_id` (точна форма квотування — як у наявних тестах
  цього файлу).

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test kind-registry stage-registers stage-posting-integrity movement-functions` → FAIL.
- [ ] **Step 3: Реалізація** — за Interfaces; `stage-scope-model.test.ts` і
  інші тести з PK незалежного регістра чи `NOT NULL` вимірів оновити під нову
  форму (зміна очікувана — назвати її в повідомленні коміту).
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/model/kinds packages/simetra/src/compiler packages/simetra/src/model/__tests__
git commit -m "feat(model): виміри регістрів nullable, ключі запису UNIQUE NULLS NOT DISTINCT" --only -- packages/simetra/src/model/kinds packages/simetra/src/compiler packages/simetra/src/model/__tests__
```

---

### Task 2: Стандартні реквізити `version` і `predefined_name`, предвизначені елементи (М18)

**Files:**
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`versionColumn()`, поле `StandardColumnDef.partialUnique`, поле `KindDefinition.namedElementFields`)
- Modify: `packages/simetra/src/model/kinds/catalog.ts`, `kinds/document.ts` (`standardColumns`, `namedElementFields`)
- Modify: `packages/simetra/src/model/schemas/catalog.ts` (`predefinedItems`)
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`standardField`, `addField` — частковий унікальний індекс)
- Modify: `packages/simetra/src/compiler/stages/identity.ts` (`namespacesOf`, `checkIdentified` без вимоги `physicalName` для таких елементів)
- Modify: `packages/simetra/src/compiler/contracts.ts` (`Contracts.predefined`), `compiler/compile.ts` (якщо потрібно для передачі)
- Test: `packages/simetra/src/model/__tests__/kind-registry.test.ts`, `kind-schemas.test.ts`, `packages/simetra/src/compiler/__tests__/stage-model.test.ts`, `stage-identity.test.ts`, `contracts.test.ts`

**Interfaces:**
- Produces:
  - `versionColumn(): StandardColumnDef` — `{ logicalName: "version", physicalName: "version", type: { type: "BigInt" }, notNull: true, default: "1", title: { uk: "Версія", en: "Version" } }`;
    у довідника й документа — одразу перед службовими датами (тригер
    збільшення — П3).
  - `StandardColumnDef.partialUnique?: string` — умова часткового
    унікального індексу (без `WHERE`). `predefined_name` у довідника:
    `partialUnique: "predefined_name IS NOT NULL"` (форма `quoteIdent`, який
    просте ім'я не квотує). Стадія 3 кладе в `indexes`
    `{ unique: true, method: "btree", keys: [носій?, predefined_name], include: [], where, nullsNotDistinct: false }`
    — у скоупленому довіднику з провідною скоуп-колонкою (елементи
    предвизначені в межах тенанта). Ім'я — тим самим механізмом, що й
    решта індексів (`assignNames`).
  - `KindDefinition.namedElementFields?: readonly string[]` — поля з
    елементами, що мають `id` і `name`, але не дають колонок і не мають
    `physicalName`. Довідник: `["predefinedItems"]`.
  - `catalogSchema.predefinedItems: { id?: MetadataId; name: string; description?: LocalizedString }[]`
    (`id` — як у `attributeSchema`: опційний у схемі, обов'язковість дає
    стадія 2).
  - Стадія 2: простір імен `Catalog <Ім'я> predefined items` — `styled: true`,
    `reserved: []`; `id` перевіряється глобально (`identity.id-missing`,
    `identity.id-duplicate`), `physicalName` — ні; дубль імені —
    `identity.name-duplicate`.
  - ```ts
    interface PredefinedContract { objectId: string; items: { id: string; name: string }[] }
    interface Contracts { posting: PostingContract[]; registers: RegisterContract[]; predefined: PredefinedContract[] }
    ```
    Лише довідники з непорожнім `predefinedItems`; сортування за `objectId`,
    `items` — у порядку файлу. Засів (`MERGE` за `id`) — П3.

- [ ] **Step 1: Тести**
- `kind-registry.test.ts`: `catalog and document carry version` —
  `version` `bigint NOT NULL DEFAULT 1` у довідника й документа, немає в
  регістрів, константи й рядка ТЧ; `predefined name is a partial unique` —
  у довідника `partialUnique` задано; у документа `predefinedName` немає.
- `stage-model.test.ts`: точні списки колонок довідника й документа
  (додати `version` перед `created_at`); `predefined name partial unique index`
  — нескоуплений довідник: індекс `unique: true`, ключі `["predefined_name"]`,
  `where` з `IS NOT NULL`; скоуплений — `["org_id", "predefined_name"]`;
  `user attribute named version` — довідник з реквізитом `version` →
  `identity.name-reserved` (Review Focus 4).
- `kind-schemas.test.ts`: `predefinedItems accept id, name, description`.
- `stage-identity.test.ts`: `predefined item without id` →
  `identity.id-missing`, pointer `/predefinedItems/0/id`; `duplicate predefined name`
  → `identity.name-duplicate`, pointer `/predefinedItems/1/name`;
  `predefined id duplicates attribute id` → `identity.id-duplicate`;
  `predefined item needs no physicalName` → без
  `identity.physical-name-missing`; `predefined name follows project case` —
  `snake_case`-проєкт, ім'я `MainWarehouse` → `identity.name-case`.
- `contracts.test.ts`: `predefined contract lists items with ids` — два
  довідники, у порядку `objectId`; довідника без предвизначених у контракті
  немає.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test kind-registry kind-schemas stage-model stage-identity contracts` → FAIL.
- [ ] **Step 3: Реалізація** — за Interfaces.
- [ ] **Step 4: Зелені** — PASS; повні гейти (тести зі списками колонок
  довідника й документа в інших файлах оновлюються під `version`).
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(model): стандартні реквізити version і predefined_name, контракт предвизначених елементів" --only -- packages/simetra/src
```

---

### Task 3: Похідні таблиці регістра накопичення, індекси рухів, межа віртуальних таблиць (М17, М20)

**Files:**
- Modify: `packages/simetra/src/model/physical/snapshot.ts` (`PhysicalOrigin.part`)
- Create: `packages/simetra/src/model/physical/period.ts` (`truncatedPeriodExpression`; експорт через `model/physical/index.ts`)
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`RegisterKeySpec.turnoversMonth`, `monthColumn()`)
- Modify: `packages/simetra/src/model/kinds/accumulation-register.ts`
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`addTotals`, новий `addTurnoversMonth`, `addRegisterKeys` — індекси)
- Modify: `packages/simetra/src/compiler/contracts.ts` (`RegisterContract`, `VIRTUAL_TABLES`, `derivedFunctions`, `buildContracts` — параметр `timezone`), `compiler/compile.ts` (передає `project.timezone`)
- Test: `packages/simetra/src/model/__tests__/kind-registry.test.ts`, `packages/simetra/src/model/__tests__/period.test.ts` (новий), `packages/simetra/src/compiler/__tests__/stage-registers.test.ts`, `contracts.test.ts`

**Interfaces:**
- Consumes: `RegisterKeySpec` задачі 1.
- Produces:
  - `RegisterKeySpec.turnoversMonth?: { split: boolean }` — регістр
    залишків `{ split: true }`, оборотний `{ split: false }`, регістр
    відомостей — немає.
  - `PhysicalOrigin.part?: "totals" | "turnoversMonth"`.
  - `truncatedPeriodExpression(column: string, unit: "year" | "quarter" | "month" | "day", timezone: string): string`
    → `date_trunc('<unit>', (<quoteIdent(column)> AT TIME ZONE '<timezone>'))::date`
    (рядкові літерали — тим самим екрануванням, що `sqlLiteral` стадії 3).
  - `monthColumn(): StandardColumnDef` — `{ logicalName: "month", physicalName: "month", type: { type: "Date" }, notNull: true, title: { uk: "Місяць", en: "Month" } }`.
  - Таблиця `<reg>_turnovers_month` (`origin.part: "turnoversMonth"`) у
    обох видів регістра накопичення: носій скоупу, виміри (`NOT NULL` лише
    `required`, ті самі FK, без `unique`), `month`, ресурси: `split` — на
    кожен ресурс `makeObjectName(<r>, undefined, "receipt")` і `…"expense"`,
    інакше `<r>`; усі `NOT NULL DEFAULT 0`, `origin.elementId` — id ресурсу.
    Ключ — `UNIQUE NULLS NOT DISTINCT (носій, виміри…, month)`, PK немає;
    без носія й вимірів — `UNIQUE (month)`.
  - `<reg>_totals` (лише залишки): виміри `NOT NULL` лише `required`
    (хардкод `notNull: true` прибрати); ключ — `UNIQUE NULLS NOT DISTINCT
    (носій, виміри…)` без PK; без вимірів — одинак, як був (зі скоупом його
    заступає скоуп-колонка PK).
  - Індекси рухів: `(носій, виміри…, period, recorder_type, recorder_id)` і
    `(носій, period)`.
  - ```ts
    export interface VirtualTableContract {
      kind: VirtualTableKind
      function: QualifiedName
      /**
       * `balance`: без реєстратора — рухи з `period <= p_at` включно; з
       * реєстратором — `(period, recorder_type, recorder_id) <
       * (p_at, p_recorder_type, p_recorder_id)`, строго до документа.
       * `p_at` NULL — поточні `totals`. SQL — П3.
       */
      parameters: { name: "p_at" | "p_from" | "p_to" | "p_recorder_type" | "p_recorder_id"; type: string }[]
      columns: { name: string; type: string }[]
    }
    export interface RegisterContract {
      registerId: string
      movements: QualifiedName
      totals?: QualifiedName
      turnoversMonth?: {
        table: QualifiedName
        /** `truncatedPeriodExpression("period", "month", <timezone проєкту>)`. */
        monthExpression: string
        /** Пара `<r>_receipt`/`<r>_expense` на ресурс замість `<r>`. */
        split: boolean
      }
      virtualTables: VirtualTableContract[]
      /** Перераховує й звіряє обидві похідні таблиці. */
      totalsMaintenance?: { recalculate: QualifiedName; verify: QualifiedName }
      balanceControl?: { resources: string[] }
    }
    ```
    `balance` — параметри `p_at timestamp with time zone`, `p_recorder_type text`,
    `p_recorder_id uuid`; решта віртуальних таблиць без змін.
    `totalsMaintenance` — у кожного регістра з `turnoversMonth` чи `totals`
    (тобто й в оборотного); `derivedFunctions` реєструє ці функції за тією
    самою умовою.
  - `buildContracts(objects, physical, style, sqlUnits, timezone: string)`.

- [ ] **Step 1: Тести**
- `period.test.ts`: `truncates in project timezone` —
  `truncatedPeriodExpression("period", "month", "Europe/Kyiv")` →
  `date_trunc('month', (period AT TIME ZONE 'Europe/Kyiv'))::date`
  (квотування колонки — як `quoteIdent`); `escapes quote in timezone` — пояс
  з `'` подвоюється.
- `kind-registry.test.ts`: `turnoversMonth` за видом регістра.
- `stage-registers.test.ts`:
  - `balance register monthly turnovers` — `stock_turnovers_month`: колонки
    `org_id`, `warehouse_id`, `item_id`, `month date NOT NULL`,
    `qty_receipt`/`qty_expense` `numeric(15,3) NOT NULL DEFAULT 0`;
    `uniques` = `[{ columns: ["org_id", "warehouse_id", "item_id", "month"], nullsNotDistinct: true }]`;
    PK немає; `origin.part === "turnoversMonth"`;
  - `turnover register monthly turnovers` — одна колонка `qty`; таблиці
    `_totals` немає;
  - `totals key is unique nulls not distinct` — `stock_totals`: PK немає,
    UNIQUE `["org_id", "warehouse_id", "item_id"]` з `nullsNotDistinct: true`;
    `item_id` nullable;
  - `scoped register without dimensions` — `turnovers_month` з UNIQUE
    `["org_id", "month"]`; `totals` з PK `org_id` (Review Focus 2);
  - `unscoped register without dimensions` — `turnovers_month` UNIQUE
    `["month"]`; `totals` — одинак;
  - `movement indexes end with recorder` — індекси `stock`:
    `["org_id", "warehouse_id", "item_id", "period", "recorder_type", "recorder_id"]`
    і `["org_id", "period"]`; жодного з ключами `[…, "period"]` без
    реєстратора;
  - `turnovers month name collision` — довідник з `physicalName: "stock_turnovers_month"`
    → `physical.table-duplicate`.
- `contracts.test.ts`:
  - `balance virtual table has recorder bound` — параметри `p_at`,
    `p_recorder_type` (`text`), `p_recorder_id` (`uuid`) у цьому порядку;
  - `monthly turnovers contract` — проєкт з `timezone: "Europe/Kyiv"`:
    `turnoversMonth.monthExpression` дорівнює виразу з `period.test.ts`,
    `split: true` у залишків і `false` в оборотного;
  - `turnover register maintains derived tables` — оборотний регістр має
    `totalsMaintenance`, `totals` немає;
  - `maintenance function name collision` — довідник з `physicalName:
    "turnover_totals_verify"` поруч з оборотним регістром `turnover` →
    `physical.function-duplicate`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test period kind-registry stage-registers contracts` → FAIL.
- [ ] **Step 3: Реалізація** — за Interfaces; `addTurnoversMonth` іде після
  `addTotals` у `add`, обидва — за фактами `registerKeys`.
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): місячні обороти регістрів накопичення, ключі підсумків NULLS NOT DISTINCT, межа залишків із реєстратором" --only -- packages/simetra/src
```

---

### Task 4: Нумерація першим записом — генерована колонка періоду, унікальність, контракт (М21)

**Files:**
- Modify: `packages/simetra/src/model/physical/snapshot.ts` (`PhysicalColumn.generated`)
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`StandardColumnDef.generated`, `NumberingSpec`, `KindDefinition.numbering`)
- Modify: `packages/simetra/src/model/kinds/document.ts`, `kinds/catalog.ts`
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`standardField`, `addField`, `add` — UNIQUE нумерації)
- Modify: `packages/simetra/src/compiler/contracts.ts` (`Contracts.numbering`)
- Test: `packages/simetra/src/model/__tests__/kind-registry.test.ts`, `packages/simetra/src/compiler/__tests__/stage-model.test.ts`, `stage-scope-model.test.ts`, `contracts.test.ts`

**Interfaces:**
- Consumes: `truncatedPeriodExpression` задачі 3.
- Produces:
  - `PhysicalColumn.generated?: { expression: string }` — завжди `STORED`;
    колонка з `generated` не має `default`.
  - `StandardColumnDef.generated?: { truncate: { column: string; unit: "year" | "quarter" | "month" | "day" } }`
    — структурно, бо пояс проєкту реєстр не знає; вираз будує стадія 3
    через `truncatedPeriodExpression(column, unit, project.timezone)`.
  - Документ: `number` — без `indexed`; при `numberPeriodicity ≠ "None"` —
    стандартна колонка `{ logicalName: "numberPeriod", physicalName: "number_period", type: { type: "Date" }, notNull: true, generated: { truncate: { column: "date", unit: <periodicity у нижньому регістрі> } }, title: { uk: "Період номера", en: "Number period" } }`
    одразу після `date`.
  - ```ts
    export interface NumberingSpec {
      /** Канонічні логічні імена стандартних колонок. */
      column: "number" | "code"
      periodColumn?: "numberPeriod"
      type: "String" | "Number"
      length: number
      autonumber: boolean
      periodicity: "None" | "Year" | "Quarter" | "Month" | "Day"
      /** UNIQUE (носій, період?, колонка) у фізичному знімку. */
      unique: boolean
    }
    KindDefinition.numbering?(obj: unknown): NumberingSpec | undefined
    ```
    Документ — завжди (`unique: true`); довідник — лише при `codeLength > 0`
    (`periodicity: "None"`, `unique: codeUnique`). Колонка коду довідника
    втрачає власний `unique` (його дає `NumberingSpec`), `indexed` лишається
    (покритий префіксом індекс відкидає `materializeIndexes`) — фізика
    довідника не змінюється.
  - Стадія 3: за `numbering.unique` — `uniques.push({ columns: [носій?, period?, колонка], nullsNotDistinct: false })`.
  - ```ts
    interface NumberingContract {
      objectId: string
      column: string           // фізичне ім'я
      periodColumn?: string    // фізичне ім'я генерованої колонки
      type: "String" | "Number"
      length: number
      autonumber: boolean
      periodicity: "None" | "Year" | "Quarter" | "Month" | "Day"
      scoped: boolean          // таблиця має власну скоуп-колонку
      assignedAt: "firstWrite"
    }
    interface Contracts { …; numbering: NumberingContract[] }   // за objectId
    ```
    Префікса немає (пізніше). Генерація лічильників — П3.

- [ ] **Step 1: Тести**
- `kind-registry.test.ts`: `numbering spec of document and catalog`;
  `catalog without code has no numbering`.
- `stage-model.test.ts`:
  - `document number period is generated` — документ з типовим `Year`,
    без скоупу: колонка `number_period` `date NOT NULL`, `generated.expression`
    = `date_trunc('year', (date AT TIME ZONE 'UTC'))::date` (квотування — як
    `quoteIdent`), `default` немає; UNIQUE `["number_period", "number"]`
    з `nullsNotDistinct: false`; індексу з ключами `["number"]` немає;
  - `quarter periodicity` — `'quarter'` у виразі; `Europe/Kyiv` у поясі,
    коли проєкт його задає;
  - `document without number periodicity` — `None`: колонки
    `number_period` немає, UNIQUE `["number"]` (Review Focus 3);
  - `catalog code uniqueness unchanged` — `codeUnique: true` → UNIQUE
    `["code"]`; `false` → UNIQUE немає, індекс `["code"]`;
  - `user attribute named number_period` — `snake_case`-проєкт, реквізит
    документа `number_period` → `identity.name-reserved` (Review Focus 4).
- `stage-scope-model.test.ts`: скоуплений документ — UNIQUE
  `["org_id", "number_period", "number"]`; скоуплений довідник —
  `["org_id", "code"]` як був.
- `contracts.test.ts`: `document numbering contract` — `periodColumn:
  "number_period"`, `periodicity: "Year"`, `scoped: true`,
  `assignedAt: "firstWrite"`; `catalog code numbering contract` — без
  `periodColumn`, `periodicity: "None"`; довідника з `codeLength: 0` немає.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test kind-registry stage-model stage-scope-model contracts` → FAIL.
- [ ] **Step 3: Реалізація** — за Interfaces.
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): нумерація першим записом — генерований період номера, унікальність і контракт" --only -- packages/simetra/src
```

---

### Task 5: Обов'язковість за видом і контракт оболонки `save`/`post`/`unpost` (М19, М22)

**Files:**
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`KindDefinition.requiredOnPost`), `kinds/document.ts`
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`attributeField` — `notNull` за видом; CHECK шапки; `PendingTable.checks[].label`; `assignNames` бере мітку)
- Modify: `packages/simetra/src/compiler/contracts.ts` (`PostingContract`, `postingFunctions`, `derivedFunctions`)
- Test: `packages/simetra/src/model/__tests__/kind-registry.test.ts`, `packages/simetra/src/compiler/__tests__/stage-model.test.ts`, `contracts.test.ts`

**Interfaces:**
- Produces:
  - `KindDefinition.requiredOnPost?: true` — документ. Для такого виду
    `required` реквізиту шапки й рядка ТЧ не дає `NOT NULL`; у решти видів
    (довідник, регістри, константа) — `NOT NULL`, як зараз.
  - CHECK шапки для кожного `required` реквізиту документа:
    `{ label: "required", column: <перша колонка>, expression: "NOT posted OR <c> IS NOT NULL" }`,
    для пари «тип + id» — `NOT posted OR (<c>_type IS NOT NULL AND <c>_id IS NOT NULL)`;
    імена через `quoteIdent`; колонку проведеності стадія 3 бере зі
    стандартних колонок за логічним іменем `posted`. Ім'я —
    `chooseConstraintName(<таблиця>, <колонка>, "required", taken)` (за
    відсутності `label` — `"check"`, як зараз).
  - ```ts
    export interface PostingContract {
      documentId: string
      save: QualifiedName      // <doc>_save(p_document jsonb, p_expected_version bigint)
      post: QualifiedName      // <doc>_post(p_id uuid)
      unpost: QualifiedName    // <doc>_unpost(p_id uuid)
      requiredOnPost: {
        /** `check` — ім'я CHECK із `PhysicalTable.checks` шапки. */
        header: { attributeId: string; columns: string[]; check: string }[]
        sections: { sectionId: string; table: QualifiedName; columns: { attributeId: string; columns: string[] }[] }[]
      }
      /** Тригер незмінності проведеного: одне ім'я на шапку й кожну ТЧ. */
      immutability: { trigger: string; tables: QualifiedName[] }
      movements: …                 // без змін
      balanceControl: …            // без змін
    }
    ```
    Порядок: `header` і `columns` — як реквізити у файлі; `sections` і
    `tables` — шапка, далі ТЧ у порядку файлу; ТЧ без `required` реквізитів у
    `sections` немає. Команда `saveAndPost` — T3 (П4), у контракті її немає.
  - `derivedFunctions` реєструє `save` поруч із `post`/`unpost`.

- [ ] **Step 1: Тести**
- `kind-registry.test.ts`: `requiredOnPost` є лише в документа.
- `stage-model.test.ts`:
  - `required document attribute is checked on posting` — реквізит шапки
    `customer` (`Ref` на довідник, `required`): колонка `customer_id`
    nullable; `checks` містить `{ name: "sale_customer_id_required", expression: "NOT posted OR customer_id IS NOT NULL" }`;
  - `required polymorphic header attribute` — CHECK покриває обидві колонки
    пари (Review Focus 5);
  - `required tabular row attribute` — колонка рядка ТЧ nullable, CHECK на
    таблиці ТЧ немає (Review Focus 5);
  - `required catalog attribute stays not null` — довідник і ресурс регістра
    відомостей з `required` — `NOT NULL`, CHECK `required` немає.
- `contracts.test.ts`:
  - `posting contract names save` — `save` = `sale_save`;
  - `required on post lists header and rows` — `header[0].check` дорівнює
    імені CHECK зі знімка; `sections` має ТЧ з `required` колонкою;
  - `immutability covers header and sections` — `trigger: "sale_immutable"`,
    `tables` — `sale`, далі таблиці ТЧ;
  - `save name collision` — довідник з `physicalName: "sale_save"` →
    `physical.function-duplicate`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test kind-registry stage-model contracts` → FAIL.
- [ ] **Step 3: Реалізація** — за Interfaces.
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): обов'язковість за видом і контракт оболонки save/post/unpost" --only -- packages/simetra/src
```

---

### Task 6: Канон і статус

**Files:**
- Modify: `docs/ROADMAP.md` (Віха 1, «Зараз»)
- Modify (якщо розходиться): `.agents/skills/code-review/references/simetra-domain-criteria.md`
- Modify: цей план (галочки)

- [ ] **Step 1: Пошук залишків старої форми** — без обрізання виводу:
  `grep -rn "dimensionsNotNull\|dimensionsUnique" packages .agents docs --include=*.ts --include=*.md`
  (у коді має бути 0 збігів; у доках — лише плани B–C2 як історичні записи,
  їх не правити) і `grep -rn "_totals" .agents docs/superpowers/specs` —
  жоден опис не каже, що ключ `totals` — PK.
- [ ] **Step 2: Критерії рев'ю** — звірити рядки Р22, Р24/Р25, Р26 у
  `simetra-domain-criteria.md` з кодом після задач 1–5; правити лише там, де
  критерій указує на місце, якого вже немає.
- [ ] **Step 3: ROADMAP** — «Зараз»: C3 виконано, далі D1; посилання на цей
  план.
- [ ] **Step 4: Гейти** — `python3 scripts/check-doc-anchors.py && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit**

```bash
git add docs/ROADMAP.md docs/superpowers/plans/2026-10-01-p2c3-physics-refinement.md .agents/skills/code-review/references/simetra-domain-criteria.md
git commit -m "docs(plan): план C3 П2 виконано; ROADMAP — далі D1" --only -- docs/ROADMAP.md docs/superpowers/plans/2026-10-01-p2c3-physics-refinement.md .agents/skills/code-review/references/simetra-domain-criteria.md
```

---

## Критерії приймання плану C3

- Вимір без `required` — nullable у рухах, `turnovers_month` і `totals`;
  ключі запису й похідних таблиць — `UNIQUE NULLS NOT DISTINCT`, PK лише в
  реєстратора й одинака.
- У довідника й документа є `version`; у довідника — `predefined_name` з
  частковим унікальним індексом; `contracts.predefined` віддає `{ id, name }`.
- `required` документа дає CHECK шапки й запис у `requiredOnPost`, а не
  `NOT NULL`; в інших видів — `NOT NULL`.
- Обидва види регістра накопичення мають `<reg>_turnovers_month`, регістр
  залишків — ще `<reg>_totals`; індекси рухів закінчуються реєстратором;
  `balance` має межу з реєстратором.
- Документ має генерований `number_period` (за періодичності) і унікальний
  номер; `contracts.numbering` — для документа й довідника з кодом.
- Контракт оболонки містить `save`, `requiredOnPost`, `immutability`.
- `dimensionsNotNull` у коді немає; гейти зелені; гард якорів чистий.
