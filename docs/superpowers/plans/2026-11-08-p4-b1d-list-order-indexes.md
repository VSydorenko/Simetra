# П4-B1d. Індекси порядків списку — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** кожен оголошений порядок списку має індекс, з якого Postgres читає
keyset-сторінку під RLS без сортування видимої множини й без читання рядків до
курсора (Рд43): пошуковий індекс реквізиту `indexed` і складений `indexes` — з
ключем останнім і скоупом першим; keyset-умова — з провідною межею; стандартний
`description` довідника — `indexed`; бенчмарк ТЧ фіксує `TABULAR_LINES_MAX`.

**Архітектура:** T1 (`packages/simetra/src/compiler/stages/model.ts`):
похідний індекс отримує мету (`search`, `foreignKey`, `copy`, `structural`), і
на матеріалізації пошуковий індекс таблиці з одноколонковим PK ключа рядка
дістає цей ключ у кінець. T0: одна функція keyset-умови з провідною межею
(`keysetFilter`) замість `keysetAfter` ядра T4 (B3-2); нею користуються ядро
й DB-тест. Наявні бази дістають DROP і CREATE індексу планом застосування
без дозволу (`catalogOnly`). Доказ —
DB-тест плану на 100 000 рядках під справжнім RLS.

**Стек:** TypeScript, Vitest, Postgres (стек `pnpm db:start`), `EXPLAIN
(ANALYZE, FORMAT JSON)`.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) Рд26, Рд43,
§4.2, §6.4, §6.7, §7.1 (рядок `TABULAR_LINES_MAX`), §13 рядок B1d, §14.3
рядок B1d, Додаток А рядок «спека П2 | індекси»;
[П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) §5 (стандартні
реквізити). Рішення архітекторки 2026-11-08 — таблиця «Рішення плану».

**Поділ і залежності.** Незалежний блок (П4-B §13: «до списків П4-D»).
Частини: **B1d-a** (Task 0–4) — спеки, T0 і T1; **B1d-b** (Task 5–6) — DB-тест
плану й застосування на наявній базі; **B1d-c** (Task 7–8) — бенчмарк ТЧ і
документи. **Передумова Task 1 — B3-2 у `main`** (`keysetAfter`, обчислювач
фільтра T4, компаратор `full`); решта B1d від B3-2 не залежить. Task 1
(`keysetFilter`) іде першою після Task 0 і може бути виконана й змерджена
окремо раніше за решту: на неї чекає B3-3 (план у `main`, ще не
виконується), який будує keyset-умову цією функцією.

## Рішення плану

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Ключ останнім отримує пошуковий індекс `indexed`, складений `indexes` і FK-індекс `Ref` з `indexed: true` (один індекс служить пошуку й перевірці FK — префікс). FK-індекс `Ref` без `indexed`, індекс копії носія й структурні індекси (рух і підсумки регістра, стандартні FK-колонки `parent_id`, `owner_id`, авторів, `parent_id` ТЧ) не змінюються | П4-B Рд43 — уточнення (Task 0) |
| Р1a | Ключ дописується лише таблиці, чий PK — одна колонка ключа рядка (`keyColumnOf`): довідник, документ, ТЧ, корінь скоупу. Таблиця зі складеним PK чи без PK (рух регістра з PK `(recorder_type, recorder_id, line_number)`, підсумки) ключа не отримує: інакше перший вимір отримав би новий широкий індекс на найнавантаженішій таблиці, а списки регістрів ключем рядка не читають. Правило — факт PK, а не гілка за видом | П4-B Рд43 — «таблиця списку» (Task 0) |
| Р2 | Пошуковий кандидат відкидається, якщо його колонки без ключа — префікс ключа PK чи UNIQUE-обмеження. Unique-індекси з виразом чи умовою (`ignoreCase`, `partialUnique`) нічого не покривають. Старий кандидат без ключа поруч з новим не матеріалізується. DB-тест плану доводить, що UNIQUE `(скоуп, реквізит)` дає індексний скан і Incremental Sort за ключем без Seq Scan і повного Sort; інший план — зупинка й звіт архітекторці | немає |
| Р3 | Індексу без скоупу першим для списку кількох скоупів немає: другий індекс на кожен порядок подвоїв би запис. Рядок §14.3 закрито рішенням «не вводимо», у §4.2 — відоме обмеження з причиною | П4-B §4.2, §14.3 |
| Р4 | `nulls` у складених `indexes` не додаємо: типовий `ASC NULLS LAST` / `DESC NULLS FIRST` покриває порядок без явного `nulls`; явний нетиповий `nulls` — відоме обмеження, його ловить dev-попередження П4-D (Рд43) | П4-B §4.2 |
| Р5 | Стандартний `description` довідника — `indexed: true` у реєстрі виду, лише коли реквізит є (`descriptionLength > 0`): типовий порядок списку довідника — за найменуванням | П2 §5 — новий абзац; П4-B Додаток А |
| Р6 | Бенчмарк ТЧ на 1, 1 000, 2 500 і 5 000 рядках — у B1d, у проєкті `bench`; числа `TABULAR_LINES_MAX` у рядках і байтах у §7.1 П4-B і рядок B1d у §13 править лише B1d | П4-B §7.1, §13 |
| Р7 | Заміна індексу на наявній базі — DROP старого й CREATE нового в транзакції застосування: `ACCESS EXCLUSIVE` на таблицю на час побудови (читання й запис стоять). Класифікатору план передає модель **живої** бази (`classifySteps(actions, live.extracted.model, …)` у `schema/apply/plan.ts`), де старий індекс відомий як неунікальний, тож його DROP — `catalogOnly`, а заміна йде без дозволу; класифікатор не змінюється. До релізу рішення не потрібне; примітка — у борг першої міграції споживача: замок на кожну перебудовану таблицю, кандидат — `CREATE INDEX CONCURRENTLY` і `DROP INDEX CONCURRENTLY` поза транзакцією | борг першої міграції (Task 8) |
| Р8 | **Keyset-умова — з провідною межею** (рішення архітекторки 2026-11-08, форма (а); пласка — за безпековим аудитом раунду 2): для порядку `(c1, …, cn, key)` і курсора `(v1, …, vn, k)` — **пласка форма сталої глибини**: `c1 ≥ v1 AND OR[ c1 > v1, AND[c1 = v1, c2 > v2], …, AND[c1 = v1, …, cn = vn, key > k] ]` з дзеркальними знаками для `desc` (глибина за мірою `withinLimits` T0, де лист — рівень 1: 4, з гілками `nulls` — 5; листів O(n²)). Вкладена форма для `ORDER_BY_MAX` колонок перевищила б `FILTER_DEPTH_MAX`, а бюджет фільтра — страж від ворожого дерева, тож межі фільтра не змінюються; будує одна функція T0 `keysetFilter(orderBy, cursor)` — для ядра T4 і для тесту; вона заступає `keysetAfter` з B3-2 (`packages/simetra/src/data/store/filter.ts`: пласка форма з гілками `isNull`), додаючи провідну межу й напрям `before`, а `keysetAfter` видаляється в тій самій зміні (принцип 5 `AGENTS.md`). Межа `c1 ≥ v1` дає Index Cond діапазону, тож сторінка читає групу рівних `c1` і саму сторінку. **Відомі обмеження §6.4:** (1) межа стоїть лише на першій колонці, тож глибока сторінка всередині довгої групи рівних значень першої колонки (наприклад, статусу) читає групу через `Filter` — DB-тест вимірює це на першій колонці низької кардинальності й записує число в розділ «Виміри» цього плану без порогу (вимір для майбутнього варіанта з порівнянням кортежів); (2) nullable-колонка без провідної межі: для необов'язкового реквізиту з типовим `asc` (`nulls last`, а таких більшість) межа — `c1 ≥ v1 OR c1 IS NULL`, з якої Postgres межі індексу може не взяти; план вимірюється й записується, і в §6.4 це записано як правило за замовчуванням, а не як рідкісний випадок | П4-B §6.4 — форма keyset і обмеження (Task 0) |

## Global Constraints

- Порядок колонок пошукового індексу: `(скоуп?, колонки реквізиту чи складеного індексу в порядку автора з `desc`, ключ рядка за зростанням)`.
- Скоуп першим — лише там, де сьогодні (`indexWithin(scope)`); корінь скоупу й ТЧ кореня — без скоупу.
- Ключ, що вже є в індексі, не дублюється.
- Ім'я індексу — тим самим алгоритмом (`<таблиця>_<колонки>_idx`), без явних імен.
- Гілок за назвою виду немає: `description` — факт реєстру виду, ключ — факт PK.
- Класифікатор кроків застосування (`packages/simetra/src/schema/apply/steps.ts`) не змінюється.
- `FILTER_DEPTH_MAX` і `FILTER_NODES_MAX` (`packages/simetra/src/model/runtime/read.ts`) не змінюються.
- `toMatchSnapshot` не вживаємо; очікування — явні значення (скіл `writing-tests`).
- Фікстури — спільні білдери (`packages/simetra/src/compiler/__tests__/fixtures/`, `fixtures/rights`), не JSON у тесті.
- Без `--` перед шаблоном vitest у `pnpm --filter`.
- DB-тести — через `pnpm db:start`/`pnpm test:db`, об'єкти з тегом прогону (хелпери `packages/simetra/test/db/connection.ts`), нічого не лишають і на збої; `ANALYZE` — лише таблиць фікстури.
- Повний `pnpm test:db` — раз на блок, перед фінальною перевіркою.
- Коментарі — українською й про «чому».

## Review Focus

1. **Глибокий курсор** читає весь префікс — Task 5 рядки «курсор у
   середині» й «курсор у кінці».
2. **UNIQUE з виразом поряд з `indexed`** (`ignoreCase`) — індекс з ключем
   лишається: Task 3 кейс `ignoreCase`.
3. **Рух регістра з `indexed` виміром** — нового широкого індексу немає:
   Task 3 кейс «рух регістра».
4. **Довідник без `description`** — індексу немає: Task 4.
5. **Наявна база зі старою формою** — заміна індексу без дозволу
   (`catalogOnly`) і дані без змін: Task 6.

---

## Task 0: Звірка й правки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` — Рд43 (Р1, Р1a); §4.2 — відомі обмеження Р3, Р4; §6.4 — форма keyset Р8 і її відомі обмеження (межа лише на першій колонці; nullable); §7.1 рядок `TABULAR_LINES_MAX` — «бенчмарк B2» → «бенчмарк B1d»; §14.3 рядок B1d — закрито Р3; Додаток А рядок «спека П2 | індекси» — зміст Р1, Р1a, Р5, статус «внесено (B1d)». Рядок B2 у §13 не чіпати (бенчмарк ТЧ з нього прибирає задача 0 ПГ-4/B2).
- Modify: `docs/superpowers/plans/2026-11-08-p4-b3-3-window-public-api.md` — один рядок у Global Constraints: «keyset-умову будує `keysetFilter` T0 (B1d); B3-3 стартує після мерджу задачі з `keysetFilter` або бере її першою задачею, якщо B1d ще не в `main`» (рішення архітекторки 2026-11-08).
- Modify: `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` §5 — новий абзац після фізики стандартних реквізитів: правило пошукового індексу (Р1, Р1a, Р2) і `description` довідника (Р5)

- [ ] **Step 1:** `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-11-08-p4-b1d-list-order-indexes.md`; розбіжності якорів — у звіт архітекторці до старту. Перевірити, чи B3-3 у `main` (для Task 1).
- [ ] **Step 2:** правки спек; `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit.** `docs(spec): B1d — індекс порядку списку, форма keyset, description довідника`

## B1d-a. T0 і T1

### Task 1: `keysetFilter` у T0

**Files:**
- Create: `packages/simetra/src/model/runtime/keyset.ts`, `src/model/runtime/__tests__/keyset.test.ts`, `packages/simetra/src/data/__tests__/keyset-equivalence.test.ts` (T4 бачить T0 і компаратор `full`; T0 не імпортує T4)
- Modify: `packages/simetra/src/model/runtime/index.ts`; `packages/simetra/src/data/store/readers.ts` і `forms.ts` — виклики `keysetAfter` → `keysetFilter`; `forms.ts` перевіряє бюджет фільтра вікна через `keysetNodesMax(orderBy)` (найгірший випадок), а не зразком курсора `"x"` з напрямом «після»; `packages/simetra/src/data/store/filter.ts` — видалити `keysetAfter` і його тести (кейси переносяться в `keyset.test.ts`)

**Interfaces:**
- Produces: `keysetNodesMax(orderBy: OrderBy): number` — найбільше число вузлів keyset-умови цього порядку за напрямами `after`/`before`, за `NULL` і не-`NULL` у курсорі (спека §6.4: «фільтр користувача з найбільшою keyset-умовою цього `orderBy`»); `keysetFilter(orderBy: OrderBy, cursor: KeysetCursor): Filter`, де `KeysetCursor = { values: Record<string, JsonValue | null>; key: string; direction: "after" | "before" }`; `orderBy` — логічний порядок запиту T0 без ключа, ключ — останній член неявно, як у `orderClause` T3; результат — фільтр-дерево T0 форми Р8.

- [ ] **Step 1: Failing test** (`keyset.test.ts`, таблицею): одна, дві й три колонки; змішані напрямки (`a ASC, b DESC`); `nulls first` і `nulls last`; `NULL` у курсорі; `after` і `before`. Очікування — точне фільтр-дерево, напр. `(a nulls first)` після `(5, k)` — `a ≥ 5 AND OR[a > 5, AND[a = 5, key > k]]`; для типового `a asc` (`nulls last`) — `OR[a ≥ 5, a isNull] AND OR[OR[a > 5, a isNull], AND[a = 5, key > k]]`. Глибина за мірою `withinLimits` T0 ≤ 5 для `ORDER_BY_MAX` колонок з гілками `nulls`. `keysetNodesMax(orderBy)` дорівнює максимуму, знайденому перебором `keysetFilter` за напрямами, `nulls` кожної колонки й `NULL`/не-`NULL` курсора, для кожного порядку таблиці й для `ORDER_BY_MAX` колонок. Для кожного такого порядку: `and: [where, keyset]`, де `where` має глибину `FILTER_DEPTH_MAX − 1` і `FILTER_NODES_MAX − keysetNodesMax(orderBy) − 1` вузлів, проходить `withinLimits` для найгіршої keyset-умови, а на вузол більше — ні; `where` глибини `FILTER_DEPTH_MAX` разом з keyset — відмова на відкритті вікна з `path` `where` (§6.4).
- [ ] **Step 2: Failing test** (`keyset-equivalence.test.ts`): для 500 випадкових рядків з колонками `Integer` і `DateTime` (без рядкових: колатор клієнта й `COLLATE "C"` бази розходяться), з `NULL` і повторами першої колонки, і кожного порядку таблиці Step 1 обчислювач фільтра T4 над `keysetFilter` пропускає рівно ті рядки, що йдуть після (до) курсора за компаратором `full` з B3-2.
- [ ] **Step 3:** реалізація; виклики ядра переведено, `keysetAfter` видалено; `pnpm --filter simetra test keyset` — PASS (обидва файли); `pnpm --filter simetra test data` — зелені (вікно й читачі на новій функції).
- [ ] **Step 4: Commit.** `feat(model): keyset-умова з провідною межею`

### Task 2: Мета похідного індексу

**Files:**
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`DerivedIndex`, `ascending`, `addField`, `addCompositeIndexes`, гілка копії носія, індекси руху й підсумків регістра, `materializeIndexes`)

**Interfaces:**
- Produces: `interface DerivedIndex { purpose: "search" | "foreignKey" | "copy" | "structural"; keys: DerivedIndexKey[] }`; `addField` — `foreignKey` для FK, `search` для `indexed`; FK `Ref` з `indexed: true` — `search` (Р1); `addCompositeIndexes` — `search`; копія носія — `copy`; рух і підсумки регістра — `structural`. Рядок `indexed: column.indexed === true && target.form !== "foreignKey"` у стандартних колонках не змінюється.

- [ ] **Step 1:** рефакторинг без зміни виходу: `pnpm --filter simetra test compiler schema` — зелені.
- [ ] **Step 2: Commit.** `refactor(compiler): мета похідного індексу`

### Task 3: Ключ останнім і правило покриття

**Files:**
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`materializeIndexes`)
- Test: `packages/simetra/src/compiler/__tests__/stage-model-indexes.test.ts` (новий, table-driven, білдери з `fixtures/`)
- Modify: тести й фікстури з формою індексів — `stage-model.test.ts`, `stage-scope-model.test.ts`, `stage-registers.test.ts`, `stage-integrity.test.ts`, `sql-namespaces.test.ts`, `creation-order.test.ts`, `rights-admin-tables.test.ts`, `fixtures/kitchen-sink.ts`; `schema/__tests__/{render-tables,desired-state,reverse-generate}.test.ts`, `schema/__tests__/fixtures/e1-fixtures.ts`; `schema/apply/__tests__/promotion-*.test.ts`; `test/db/diff.test.ts`; хеш-літерали, що залежать від форми (`custom-table-physics.test.ts`, `runtime-catalog.test.ts` — перевірити); designer — тести з `_idx`; `examples/reference/accepted/expected-diff.json` (і `service-accrual.sql`, якщо зачеплено)

- [ ] **Step 1: Failing test** — очікувані `keys` індексів таблиці:

| Кейс | Очікування |
| --- | --- |
| скоуплений довідник, `indexed` `a` | `(org_id, a, id)` |
| нескоуплений довідник, `indexed` `a` | `(a, id)` |
| корінь скоупу, `indexed` `a` | `(a, id)` |
| `indexed` `Ref` `r` у скоупленому | FK-індекс `(org_id, r_id, id)`; окремого `(org_id, r_id)` немає |
| `Ref` без `indexed` | `(org_id, r_id)` без змін |
| стандартні `parent_id`, `owner_id`, автори; `parent_id` ТЧ | без змін |
| `unique` `a` у скоупі + `indexed` | лише UNIQUE `(org_id, a)` |
| `unique` з `ignoreCase` + `indexed` | unique-індекс `lower(a)` і `(org_id, a, id)` |
| складений `[a, { name: b, order: desc }]` | `(org_id, a, b DESC, id)` |
| складений, що містить `id` | `id` не дублюється |
| складений з `Ref` поліморфної пари | пара колонок, далі `id` |
| ТЧ зі складеним `indexes` | `(…колонки, <ключ ТЧ>)` |
| рух регістра з `indexed` виміром | без нового індексу; індекс руху без змін |
| стандартний `code` з UNIQUE нумерації | лише UNIQUE, як сьогодні |
| два кандидати з однаковими колонками | один індекс |

- [ ] **Step 2:** `pnpm --filter simetra test stage-model-indexes` — FAIL.
- [ ] **Step 3:** `materializeIndexes`: для `search` таблиці з PK з однієї колонки `keyColumnOf` — дописати ключ, якщо його немає; відкинути `search`, якщо `keys` без ключа — префікс ключа PK чи UNIQUE; решта покриття — як сьогодні над повними `keys`.
- [ ] **Step 4:** `pnpm --filter simetra test stage-model-indexes` — PASS; оновити тести й фікстури з переліку; `pnpm --filter simetra test` і `pnpm --filter @simetrajs/designer test` — зелені; `pnpm db:start`; `pnpm --filter simetra test:db paper-test` — зелений з оновленим `expected-diff.json`.
- [ ] **Step 5: Commit.** `feat(compiler): ключ останнім у пошуковому індексі порядку списку`

### Task 4: `description` довідника — `indexed`

**Files:**
- Modify: `packages/simetra/src/model/kinds/catalog.ts` (стандартна колонка `description`: `indexed: true`)
- Test: `packages/simetra/src/compiler/__tests__/stage-model-indexes.test.ts`

- [ ] **Step 1: Failing test:** скоуплений довідник з `descriptionLength > 0` — `(org_id, description, id)`; `descriptionLength = 0` — індексу `description` немає.
- [ ] **Step 2:** реалізація; PASS; оновити зачеплені тести, `expected-diff.json` і хеш-літерали; `pnpm --filter simetra test`, `pnpm --filter @simetrajs/designer test`, `pnpm metadata:check`, `pnpm --filter simetra test:db paper-test` — зелені.
- [ ] **Step 3: Commit.** `feat(model): пошуковий індекс найменування довідника`

**Готово B1d-a:** unit T0 і T1 зелені, наявні тести й еталон оновлено; правки спек внесено.

## B1d-b. Доказ на базі

### Task 5: DB-тест плану keyset-сторінки під RLS

**Files:**
- Create: `packages/simetra/test/db/list-order-plan.db.test.ts`
- Modify: `packages/simetra/test/db/explain-plan.ts` — поле `rowsRemovedByFilter` у `PlanNode` (з `Rows Removed by Filter` плану)
- Use: `explain-plan.ts` (`planNodes`, `scansOf`), `connection.ts` (`queryAs`, run-tag), фікстури прав `src/compiler/__tests__/fixtures/rights` (`compileRights`) і `test/db/rights-seed.ts` (`deploy`) — як у `rights-plan-gate.db.test.ts`

**Interfaces:**
- Consumes: `prepareRead(catalog, query)` T3 → `plan.statement` (текст і параметри); `keysetFilter` (Task 1).

- [ ] **Step 1:** фікстура через фікстури прав (справжні політики RLS): скоуплений довідник з обов'язковим `indexed` `a` (`Integer`, 1 000 різних значень), обов'язковим `indexed` `s` (`Integer`, 5 різних значень), nullable `indexed` `n` (30 % `NULL`), `unique` `u`, складеним `[a, { name: b, order: desc }]`, `indexed` `Ref` `r`, стандартним `description`; 100 000 рядків у двох скоупах (`generate_series`), `ANALYZE` лише таблиць фікстури; користувач з правом читання одного скоупу.
- [ ] **Step 2:** для кожного порядку — три сторінки: перша, курсор у середині (рядок 50 000 скоупу), курсор за 100 рядків до кінця; `limit` 100, умова `keysetFilter`, фільтр одного скоупу; `EXPLAIN (ANALYZE, FORMAT JSON)` під роллю запиту з claims користувача. Для вузла скану **таблиці списку** (`scansOf` за назвою таблиці):

| Порядок | Очікування |
| --- | --- |
| `a`, ключ | Index (Only) Scan на `(org_id, a, id)`; Index Cond має `org_id` і межу `a`; `actual rows + rowsRemovedByFilter` вузла ≤ 100 + розмір групи рівних `a` + 1; жодного вузла Sort, зокрема Incremental Sort; немає Seq Scan |
| `a DESC`, ключ | той самий індекс назад; дозволено Incremental Sort за ключем; немає Seq Scan і повного Sort |
| `a`, `b DESC`, ключ | `(org_id, a, b DESC, id)`; немає Seq Scan і Sort |
| `r`, ключ | `(org_id, r_id, id)`; немає Seq Scan і Sort |
| `description`, ключ | `(org_id, description, id)`; немає Seq Scan і Sort |
| `u`, ключ (Р2) | UNIQUE `(org_id, u)` і Incremental Sort за ключем; немає Seq Scan і повного Sort |
| ключ | PK; немає Seq Scan і Sort |
| `s` (5 різних значень), ключ — курсор у середині групи рівних `s` | жодного вузла Sort, зокрема Incremental Sort; виміряти `actual rows + rowsRemovedByFilter` і час вузла таблиці; записати в розділ «Виміри» плану; порогу немає (Р8, обмеження 1) |
| `n` (nullable), ключ | записати план у розділ «Виміри»; якщо є Seq Scan чи повний Sort — відоме обмеження §4.2 (Р8), тест фіксує поточний план, а не вимагає кращого |

- [ ] **Step 3:** RLS діє: предикат скоупу політики є в Index Cond вузла таблиці; та сама сторінка для чужого скоупу дає 0 рядків і теж без Seq Scan таблиці.
- [ ] **Step 4:** автоматичний негативний контроль у тому самому тесті під `SAVEPOINT` (відкат після кейсу, щоб не зламати наступні), DDL — від власника до `asRole`: створити індекс старої форми `(org_id, s)` і прибрати новий — план порядку `s`, ключ для курсора в середині має Incremental Sort за ключем над групою ≈ 10 000 рядків, тож правило рядка `s` («жодного Sort») червоне. Другий контроль — keyset без провідної межі на новому індексі: правило рядка `a` (`actual rows + rowsRemovedByFilter`) червоне.
- [ ] **Step 5:** `pnpm db:start`; `pnpm --filter simetra test:db list-order-plan` — PASS. Інший план для рядка `u` чи для глибокого курсора — зупинка й звіт архітекторці (Р2, Р8).
- [ ] **Step 6: Commit.** `test(db): план keyset-сторінки під RLS для оголошених порядків`

### Task 6: Застосування на наявній базі

**Files:**
- Create: `packages/designer/src/__tests__/list-order-index-apply.db.test.ts` (білдери фікстур designer, як у сусідніх `*-apply*.db.test.ts`)

- [ ] **Step 1:** база зі схемою старої форми `(org_id, a)` і рядками; план застосування нової моделі: DROP старого неунікального індексу — `catalogOnly`, CREATE нового — без класу; план застосовується без дозволу; нова форма, дані без змін, відбиток стану зелений. Контроль: той самий план на базі, де старий індекс унікальний, вимагає дозволу `relaxation`.
- [ ] **Step 2:** `pnpm --filter @simetrajs/designer test:db list-order-index-apply` — PASS.
- [ ] **Step 3: Commit.** `test(designer): заміна індексу порядку на наявній базі`

**Готово B1d-b:** DB-тест плану й тест застосування зелені.

## B1d-c. Бенчмарк ТЧ і документи

### Task 7: Бенчмарк ТЧ

**Files:**
- Create: `packages/simetra/bench/tabular.bench.db.ts` (проєкт `bench` з `packages/simetra/vitest.config.ts`, зразок — `bench/rights.bench.db.ts`)
- Modify: `packages/simetra/package.json` — скрипт `bench:tabular` (`vitest run --project bench tabular`); `bench:rights` звузити до `vitest run --project bench rights`, щоб він не запускав новий файл

- [ ] **Step 1:** тегована база прогону (хелпери `connection.ts`), прибирання в `afterAll` і на збої; довідник з ТЧ із 8 реквізитів (`String` 50, `Numeric` 15,2, `Integer`, `Date`, `Boolean`, `Ref`, два `String` 100); `runtime.run` `update` з повним масивом ТЧ (`fullTabularArrays`) на 1, 1 000, 2 500 і 5 000 рядках, 10 прогонів після прогріву: медіана й p90 часу транзакції з `COMMIT`, `jsonBytes` операції у формі передачі, `jsonBytes` відповіді картки з ТЧ.
- [ ] **Step 2:** `pnpm db:start`; `pnpm --filter simetra bench:tabular` — числа в журналі.
- [ ] **Step 3:** правило: `TABULAR_LINES_MAX` = 5 000 лишається, якщо на 5 000 рядках медіана `run` ≤ 2 с, байти операції ≤ 3 МіБ і байти відповіді картки ≤ 3 МіБ (запас до межі тіла й бюджету відповіді 4 МБ, §4.5). Інакше — **стоп**: найбільше виміряне число, що вкладається, і звіт архітекторці; сталу T0 (`packages/simetra/src/model/runtime/read.ts`) і похідні тести змінює окремий крок після її рішення. Записати рядки й байти в §7.1 П4-B і в рядок B1d §13.
- [ ] **Step 4: Commit.** `test(bench): бенчмарк ТЧ і межа TABULAR_LINES_MAX`

### Task 8: Документи й фінальні гейти

**Files:**
- Modify: `docs/ROADMAP.md` (B1d); борг першої міграції споживача — примітка Р7 (документ боргу, який ROADMAP називає для першої міграції); `packages/designer/skills/simetra-metadata/SKILL.md` — що дає `indexed` і складений `indexes`: індекс порядку списку з ключем останнім

- [ ] **Step 1:** правки; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `pnpm test:db` (раз на блок).
- [ ] **Step 3: Commit.** `docs: B1d — індекси порядків списку`

**Готово B1d:** unit T0 і T1, DB-тест плану, тест застосування зелені; числа бенчмарку в §7.1; спеки, борг і скіл синхронізовано.

## Виміри

Заповнює виконавець Task 5 і Task 7 (числа, не пороги):

| Вимір | Значення |
| --- | --- |
| `s` (5 значень), курсор у середині групи: `actual rows + rowsRemovedByFilter`, час вузла таблиці | — |
| `n` (nullable), курсор у середині: план, `actual rows` | — |
| ТЧ 1 / 1 000 / 2 500 / 5 000 рядків: медіана й p90 `run`, байти операції й відповіді | — |

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Червоніє |
| --- | --- |
| ключ не дописується | Task 3 (рядки з `id`); Task 5 рядок «`a`, ключ», курсор у середині |
| keyset без провідної межі (`a > x OR (a = x AND key > k)`) | Task 5 рядок «`a`, ключ» (`actual rows + rowsRemovedByFilter`) і Step 4; Task 1 Step 1 (форма дерева). `keyset-equivalence` лишається зеленим — межа потрібна плану, а не змісту |
| ключ дописується до FK `Ref` без `indexed` | Task 3 рядок «`Ref` без `indexed`» |
| ключ дописується таблиці зі складеним PK | Task 3 рядок «рух регістра» |
| ключ береться не з PK | Task 3 рядок «ТЧ зі складеним» |
| правило покриття Р2 вимкнено | Task 3 рядок «`unique` + `indexed`» |
| UNIQUE з виразом покриває пошуковий | Task 3 рядок `ignoreCase` |
| старий кандидат без ключа матеріалізується поруч | Task 3 рядок «`indexed` `Ref`» |
| `description` індексується без перевірки наявності | Task 4 |
| класифікатор вважає будь-який знятий індекс неунікальним | Task 6 контроль (унікальний старий індекс — `relaxation`); `steps.test.ts` «dropping an index the target model does not know is a relaxation» |
| `keysetAfter` лишився поруч з `keysetFilter` | Task 1 Step 3 (пошук `keysetAfter` у `src/` порожній) |
| скоуп не першим | Task 3; Task 5 |
| піднято `FILTER_DEPTH_MAX` чи `FILTER_NODES_MAX` | Task 1 Step 1 («на вузол більше — ні»); наявні тести меж фільтра T0 |
| keyset у вкладеній формі | Task 1 Step 1 (глибина ≤ 5) |
| `keysetNodesMax` занижено (рахує лише `after` чи не-`NULL`) | Task 1 Step 1 (звірка з перебором) |
| `forms.ts` міряє бюджет зразком курсора | Task 1 Step 1 (`before` з `NULL` у курсорі на межі бюджету) |
