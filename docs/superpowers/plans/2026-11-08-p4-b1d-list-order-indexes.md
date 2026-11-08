# П4-B1d. Індекси порядків списку — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** кожен оголошений порядок списку має індекс, з якого Postgres читає
keyset-сторінку під RLS без сортування видимої множини (Рд43): пошуковий
індекс реквізиту `indexed` і складений `indexes` — з ключем останнім і скоупом
першим; стандартний `description` довідника — `indexed`; бенчмарк ТЧ фіксує
`TABULAR_LINES_MAX`.

**Архітектура:** зміна — у T1 (`packages/simetra/src/compiler/stages/model.ts`):
похідний індекс отримує мету (`search`, `foreignKey`, `copy`), і на
матеріалізації пошуковий індекс дістає колонки первинного ключа таблиці в
кінець. Правило покриття розрізняє «префікс ключа UNIQUE» і «префікс без
ключа»: реквізит з UNIQUE пошукового індексу з ключем не отримує. Наявні бази
дістають DROP і CREATE індексу планом застосування (ім'я індексу виводиться з
колонок). Доказ — DB-тест плану на 100 000 рядках під RLS.

**Стек:** TypeScript, Vitest, Postgres (стек `pnpm db:start`), `EXPLAIN
(ANALYZE, FORMAT JSON)`.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) Рд43, §4.2,
§6.7, §7.1 (рядок `TABULAR_LINES_MAX`), §13 рядок B1d, §14.3 рядок B1d,
Додаток А рядок «спека П2 | індекси»;
[П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) (фізика стандартних
реквізитів). Рішення архітекторки 2026-11-08 — таблиця «Рішення плану».

**Поділ і залежності.** Незалежний блок (П4-B §13: «до списків П4-D»).
Частини: **B1d-a** (Task 0–3) — спеки й T1; **B1d-b** (Task 4–5) — DB-тест
плану й застосування на наявній базі; **B1d-c** (Task 6–7) — бенчмарк ТЧ і
документи.

## Рішення плану

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Ключ останнім отримує пошуковий індекс `indexed`, складений `indexes` і FK-індекс `Ref` з `indexed: true` (один індекс служить і пошуку, і перевірці FK — префікс). FK-індекс `Ref` без `indexed` і індекс копії носія не змінюються | П4-B Рд43 — уточнення (Task 0) |
| Р2 | Пошуковий кандидат відкидається, якщо його колонки без ключа — префікс ключа PK чи UNIQUE-обмеження. Unique-індекси з виразом чи умовою (`ignoreCase`, `partialUnique`) нічого не покривають. Старий кандидат без ключа не матеріалізується поруч з новим. DB-тест плану доводить, що UNIQUE `(скоуп, реквізит)` дає Index Scan і Incremental Sort за ключем без Seq Scan і повного Sort; інший план — зупинка й звіт архітекторці (не відкидати кандидата мовчки) | немає |
| Р3 | Індексу без скоупу першим для списку кількох скоупів немає: другий індекс на кожен порядок подвоїв би запис. Рядок §14.3 закрито рішенням «не вводимо», у §4.2 — відоме обмеження з причиною | П4-B §4.2, §14.3 |
| Р4 | `nulls` у складених `indexes` не додаємо: типовий `ASC NULLS LAST` / `DESC NULLS FIRST` покриває порядок без явного `nulls`; порядок з явним нетиповим `nulls` — відоме обмеження, його ловить dev-попередження П4-D (Рд43) | П4-B §4.2 |
| Р5 | Стандартний `description` довідника — `indexed: true` у реєстрі виду, лише коли реквізит є (`descriptionLength > 0`): типовий порядок списку довідника — за найменуванням | П2 — новий абзац; П4-B Додаток А (Task 0) |
| Р6 | Бенчмарк ТЧ на 1, 1 000 і 5 000 рядках — у B1d; числа `TABULAR_LINES_MAX` у рядках і байтах у §7.1 П4-B і рядок B1d у §13 править лише B1d | П4-B §7.1, §13 |
| Р7 | Заміна індексу на наявній базі — DROP і CREATE без `CONCURRENTLY`, тобто замок запису таблиці на час побудови. До релізу рішення не потрібне; це примітка для першої міграції споживача | ROADMAP / борг першої міграції (Task 7) |

## Global Constraints

- Порядок колонок пошукового індексу: `(скоуп?, колонки реквізиту чи складеного індексу в порядку автора з `desc`, колонки PK таблиці за зростанням)`.
- Скоуп першим — лише там, де сьогодні (`indexWithin(scope)`: таблиця з власною колонкою скоупу); корінь скоупу й ТЧ кореня — без скоупу.
- Колонку PK уже в індексі не дублюємо; таблиця без PK ключа не отримує.
- Ім'я індексу — тим самим алгоритмом (`<таблиця>_<колонки>_idx`), без явних імен.
- Гілок за назвою виду немає: `description` — факт реєстру виду.
- Без `--` перед шаблоном vitest у `pnpm --filter`.
- DB-тести — через `pnpm db:start`/`pnpm test:db`, об'єкти з тегом прогону (хелпери `packages/simetra/test/db/connection.ts`), нічого не лишають і на збої.
- Повний `pnpm test:db` — раз на блок, перед фінальною перевіркою.
- Коментарі — українською й про «чому».

## Review Focus

1. **UNIQUE з виразом поряд з `indexed`** (`ignoreCase`) — індекс з ключем
   мусить лишитися: Task 2 кейс `ignoreCase`.
2. **Складений індекс, що починається з колонки PK** — ключ не дублюється:
   Task 2 кейс «PK уже в індексі».
3. **`desc` у складеному індексі й порядок `asc`** — план читає індекс назад з
   Incremental Sort, а не Seq Scan: Task 4 кейс `desc`.
4. **Довідник без `description`** (`descriptionLength = 0`) — індексу немає:
   Task 3.
5. **Наявна база зі старою формою** — план застосування дає заміну без
   дозволу на руйнування й зберігає дані: Task 5.

---

## Task 0: Звірка й правки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (Рд43 — Р1; §4.2 — відомі обмеження Р3, Р4; §14.3 рядок B1d — закрито Р3; Додаток А рядок «спека П2 | індекси» — зміст Р1 і Р5, статус «внесено (B1d)»)
- Modify: `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` — новий абзац у розділі фізики стандартних реквізитів: правило пошукового індексу (Р1, Р2) і `description` довідника (Р5)

- [ ] **Step 1:** `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-11-08-p4-b1d-list-order-indexes.md`; розбіжності якорів — у звіт архітекторці до старту.
- [ ] **Step 2:** правки спек; `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit.** `docs(spec): B1d — правило індексу порядку списку й description довідника`

## B1d-a. T1

### Task 1: Мета похідного індексу

**Files:**
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`DerivedIndex`, `ascending`, `addField`, `addCompositeIndexes`, гілка копії носія, `materializeIndexes`)

**Interfaces:**
- Produces: `interface DerivedIndex { purpose: "search" | "foreignKey" | "copy"; keys: DerivedIndexKey[] }`; `addField` дає `foreignKey` для FK, `search` для `indexed`; `indexed` `Ref` позначає FK-кандидата як `search` (Р1); `addCompositeIndexes` — `search`; копія носія — `copy`.

- [ ] **Step 1:** рефакторинг без зміни виходу: усі наявні тести T1 і T2 зелені (`pnpm --filter simetra test compiler schema`).
- [ ] **Step 2: Commit.** `refactor(compiler): мета похідного індексу`

### Task 2: Ключ останнім і правило покриття

**Files:**
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`materializeIndexes`)
- Test: `packages/simetra/src/compiler/__tests__/stage-model-indexes.test.ts` (новий, table-driven, фікстури — спільні білдери тестів компілятора, а не JSON у тесті)
- Modify: наявні тести й фікстури з формою індексів (`stage-model.test.ts`, `stage-scope-model.test.ts`, `stage-registers.test.ts`, `stage-integrity.test.ts`, `custom-table-physics.test.ts`, `sql-namespaces.test.ts`, `creation-order.test.ts`, `rights-admin-tables.test.ts`, `fixtures/kitchen-sink.ts`; `schema/__tests__/{render-tables,desired-state,reverse-generate}.test.ts`, `schema/__tests__/fixtures/e1-fixtures.ts`; `schema/apply/__tests__/promotion-*.test.ts`; `test/db/diff.test.ts`; designer — тести з `_idx`)

- [ ] **Step 1: Failing test** — таблиця кейсів, очікувані `keys` індексу таблиці:

| Кейс | Очікування |
| --- | --- |
| скоуплений довідник, `indexed` реквізит `a` | `(org_id, a, id)` |
| нескоуплений довідник, `indexed` `a` | `(a, id)` |
| корінь скоупу, `indexed` `a` | `(a, id)` |
| `indexed` `Ref` `r` у скоупленому | FK-індекс `(org_id, r_id, id)`; окремого `(org_id, r_id)` немає |
| `Ref` без `indexed` | FK-індекс `(org_id, r_id)` без змін |
| `unique` `a` у скоупі + `indexed` | лише UNIQUE `(org_id, a)`, пошукового індексу немає |
| `unique` з `ignoreCase` + `indexed` | unique-індекс `lower(a)` і пошуковий `(org_id, a, id)` |
| складений `[a, { name: b, order: desc }]` | `(org_id, a, b DESC, id)` |
| складений, що містить `id` | `id` не дублюється |
| ТЧ зі складеним `indexes` | `(…колонки, <ключ ТЧ>)` |
| таблиця без PK (`CustomTable` без ключа) з `indexed` | без ключа в кінці |
| два кандидати з однаковими колонками | один індекс |

- [ ] **Step 2:** `pnpm --filter simetra test stage-model-indexes` — FAIL.
- [ ] **Step 3:** `materializeIndexes`: для `search` дописати колонки PK, яких немає в `keys`; відкинути `search`, якщо `keys` без ключа — префікс ключа PK/UNIQUE; решта правил покриття — як сьогодні над повними `keys`.
- [ ] **Step 4:** `pnpm --filter simetra test stage-model-indexes` — PASS; оновити наявні тести й фікстури на нову форму (лише імена й колонки індексів); `pnpm --filter simetra test` і `pnpm --filter @simetrajs/designer test` — зелені.
- [ ] **Step 5: Commit.** `feat(compiler): ключ останнім у пошуковому індексі порядку списку`

### Task 3: `description` довідника — `indexed`

**Files:**
- Modify: `packages/simetra/src/model/kinds/catalog.ts` (стандартна колонка `description`: `indexed: true`)
- Test: `packages/simetra/src/compiler/__tests__/stage-model-indexes.test.ts`

- [ ] **Step 1: Failing test:** довідник з `descriptionLength > 0` у скоупі — індекс `(org_id, description, id)`; довідник з `descriptionLength = 0` — індексу `description` немає.
- [ ] **Step 2:** реалізація; тест — PASS; оновити фікстури й знімки, що зачепила нова колонка індексу; `pnpm --filter simetra test` і `pnpm --filter @simetrajs/designer test` — зелені; `pnpm metadata:check` — зелено.
- [ ] **Step 3: Commit.** `feat(model): пошуковий індекс найменування довідника`

**Готово B1d-a:** unit T1 зелені, наявні тести оновлено; правки спек внесено.

## B1d-b. Доказ на базі

### Task 4: DB-тест плану keyset-сторінки під RLS

**Files:**
- Create: `packages/simetra/test/db/list-order-plan.db.test.ts`
- Use: `packages/simetra/test/db/explain-plan.ts` (`planNodes`), `connection.ts` (`queryAs`, run-tag), зразок сіду й ролі — `rights-plan-gate.db.test.ts`

**Interfaces:**
- Consumes: `prepareRead(catalog, query)` T3 → `plan.statement` (текст і параметри); keyset-умова — фільтр-дерево T0 у `where` (повний кортеж сортування плюс ключ, як будує ядро T4, спека П4-B §6.4).

- [ ] **Step 1:** фікстура: скоуплений довідник з `indexed` `a` (`Integer`), `unique` `u`, складеним `[a, { name: b, order: desc }]`, `indexed` `Ref` `r`, стандартним `description`; 100 000 рядків у двох скоупах (`generate_series`), `ANALYZE`; користувач з правом читання одного скоупу.
- [ ] **Step 2:** для кожного порядку — перша сторінка й сторінка після курсора (`limit` 100, keyset-умова) з фільтром одного скоупу, `EXPLAIN (ANALYZE, FORMAT JSON)` під роллю запиту з claims користувача:

| Порядок | Очікування плану |
| --- | --- |
| `a`, ключ | Index Scan чи Index Only Scan на `(org_id, a, id)`; немає Seq Scan і Sort |
| `a DESC`, ключ | той самий індекс назад; дозволено Incremental Sort за ключем; немає Seq Scan і повного Sort |
| `a`, `b DESC`, ключ | індекс `(org_id, a, b DESC, id)`; немає Seq Scan і Sort |
| `r`, ключ | FK-індекс `(org_id, r_id, id)`; немає Seq Scan і Sort |
| `description`, ключ | `(org_id, description, id)`; немає Seq Scan і Sort |
| `u`, ключ (Р2) | UNIQUE `(org_id, u)` і Incremental Sort за ключем; немає Seq Scan і повного Sort |
| ключ | PK; немає Seq Scan і Sort |

  Немає Sort — це немає вузла `Sort` над сканом таблиці; `Incremental Sort` з `Presorted Key` — дозволений лише там, де названо.
- [ ] **Step 3:** `pnpm db:start`; `pnpm --filter simetra test:db list-order-plan` — PASS (негативний контроль: прибрати ключ з індексу локально — рядок «`a`, ключ» червоний, потім повернути). Інший план для рядка `u` — зупинка й звіт архітекторці (Р2).
- [ ] **Step 4: Commit.** `test(db): план keyset-сторінки під RLS для оголошених порядків`

### Task 5: Застосування на наявній базі

**Files:**
- Test: `packages/designer/src/__tests__/list-order-index-apply.db.test.ts` (поряд із сусідніми DB-тестами застосування designer)

- [ ] **Step 1:** база зі схемою старої форми (`(org_id, a)`) і рядками; план застосування нової моделі — DROP старого й CREATE нового неунікального індексу, класифіковані як заміна без дозволу на руйнування (`isReplacement`, `schema/apply/steps.ts`); після застосування — нова форма, дані без змін, відбиток стану зелений.
- [ ] **Step 2:** `pnpm --filter @simetrajs/designer test:db list-order-index-apply` — PASS.
- [ ] **Step 3: Commit.** `test(designer): заміна індексу порядку на наявній базі`

**Готово B1d-b:** DB-тест плану й тест застосування зелені.

## B1d-c. Бенчмарк ТЧ і документи

### Task 6: Бенчмарк ТЧ

**Files:**
- Create: `packages/simetra/test/db/tabular-bench.db.test.ts` (`describe.skipIf(!process.env.SIMETRA_BENCH)`, як `signal-bench` плану ПГ-4/B2)

- [ ] **Step 1:** довідник з ТЧ із 8 реквізитів (`String` 50, `Numeric` 15,2, `Integer`, `Date`, `Boolean`, `Ref`, два `String` 100); `runtime.run` `update` з повним масивом ТЧ на 1, 1 000 і 5 000 рядках, по 5 прогонів після прогріву: медіана й p95 часу транзакції, `jsonBytes` операції у формі передачі, `jsonBytes` відповіді картки з ТЧ.
- [ ] **Step 2:** `SIMETRA_BENCH=1 pnpm --filter simetra test:db tabular-bench` — числа в журналі тесту.
- [ ] **Step 3:** правило висновку: `TABULAR_LINES_MAX` = 5 000 лишається, якщо медіана `run` на 5 000 рядках ≤ 2 с і байти операції ≤ 3 МіБ (запас до межі тіла 4 МБ); інакше — найбільше число з виміряних, що вкладається, і звіт архітекторці до зміни сталої T0. Записати рядки й байти в §7.1 П4-B (рядок `TABULAR_LINES_MAX`) і в рядок B1d §13.
- [ ] **Step 4: Commit.** `test(db): бенчмарк ТЧ і межа TABULAR_LINES_MAX`

### Task 7: Документи й фінальні гейти

**Files:**
- Modify: `docs/ROADMAP.md` (B1d), борг першої міграції споживача — примітка Р7 (місце — той документ боргу, який ROADMAP називає для першої міграції), скіл споживача `packages/designer/skills/simetra-metadata/SKILL.md` (що дає `indexed` і складений `indexes`: індекс порядку списку з ключем останнім)

- [ ] **Step 1:** правки; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `pnpm test:db` (раз на блок).
- [ ] **Step 3: Commit.** `docs: B1d — індекси порядків списку`

**Готово B1d:** unit T1, DB-тест плану, тест застосування зелені; числа бенчмарку в §7.1; спеки й скіл синхронізовано.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Червоніє |
| --- | --- |
| ключ не дописується | Task 2 (усі рядки з `id`); Task 4 рядок «`a`, ключ» |
| ключ дописується й до FK-індексу `Ref` без `indexed` | Task 2 рядок «`Ref` без `indexed`» |
| UNIQUE з виразом покриває пошуковий | Task 2 рядок `ignoreCase` |
| старий кандидат без ключа матеріалізується поруч | Task 2 рядок «`indexed` `Ref`» (зайвий індекс) |
| `description` індексується без перевірки наявності | Task 3 (`descriptionLength = 0`) |
| скоуп не першим | Task 2; Task 4 (Sort над видимою множиною) |
