# Порядок колонок у копії доказу: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: прийнято архітектором задачі 2026-10-17; рішення 3 підтверджено
(зняття — окремий коміт після зеленої задачі 2, зі стоп-гейтом за фактом).

**Мета:** копія доказу відтворює порядок колонок цілі (`attnum`) для кожної
таблиці, яку вона створює, тож проєкт із документом (згенерована колонка
`number_period`) лишається придатним до планування після будь-якої зміни
реквізитів.

**Архітектура:** адаптер pg-delta перед планом «засіяна копія → ціль» додає до
факт-бази цілі синтетичні ребра `depends` між сусідніми за `_position`
колонками кожної нової таблиці (`withColumnOrder`). Ребра змушують
топологічне сортування двигуна створювати колонки рівно в порядку цілі і
забороняють компакції вбудовувати в `CREATE TABLE` колонку, що стоїть після
невбудовної. Порівняння порядку колонок (`cloneMismatch`, `columnOrder: true`)
не змінюється.

**Технології:** TypeScript 7, Vitest, `@supabase/pg-delta` `1.0.0-alpha.56`,
локальний стек Supabase (Postgres 17).

**Спека:** [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
§6.9, останній абзац: «копія доказу відтворює порядок цілі точно». Код зараз
розходиться зі спекою; план приводить код до неї. Вхід —
[залишковий борг П3-2b](2026-10-15-p3-2b-residual-debt.md) §1, пункт «Копія
доказу ставить згенеровану колонку в кінець таблиці». Попереднє рішення про
порядок колонок — [П3-2b-0](2026-10-13-p3-2b-0-proof-defects.md), рішення 1 і
R4.

**Передумова:** гілка `docs/p2-metamodel-spec`, локальний стек; на checkout
комітить одна сесія.

**Архітектор задачі:** сесія, що замовила план; якщо її немає — власник.

## Корінь дефекту (доведено читанням коду)

Гіпотезу боргу підтверджено й уточнено. Код — пакет
`@supabase/pg-delta@1.0.0-alpha.56`, теки `src/plan/` у `node_modules`:

1. **Таблиця створюється порожньою, колонки — окремими діями.** Правило
   `table` (`plan/rules/tables.ts`) для звичайної таблиці видає
   `CREATE TABLE … ()` з `acceptsColumnFolds`, а правило `column` — окрему
   дію `ALTER TABLE … ADD COLUMN` для кожної колонки.
2. **Згенерована колонка ніколи не вбудовується.** Правило `column` дає
   підказку згортання (`compaction.foldInto`) лише колонці без
   `generatedExpr`: коментар двигуна пояснює це тим, що вираз посилається на
   інші колонки, а згортання в порожній `CREATE TABLE` до них дало б
   невалідний SQL.
3. **Наступні колонки згортаються повз неї.** Фаза впорядкування
   (`plan/phases/action-graph.ts`) сортує створення колонок за `_position`
   (`pg_attribute.attnum`), а компакція (`compactColumnFolds`,
   `plan/internal.ts`) згортає кожну колонку окремо, перевіряючи лише її
   власних попередників у графі. Що ранішу сусідню колонку не згорнуто,
   вона не перевіряє. Тож колонки після згенерованої потрапляють у
   `CREATE TABLE`, а згенерована йде окремим `ADD COLUMN` після нього, тобто
   в кінець.
4. **Той самий клас — будь-яка невбудовна колонка.** Компакція не згортає й
   колонку, чий попередник (тип, домен, функція виразу) стоїть у порядку
   після `CREATE TABLE`. Ваги правил: таблиця 4, колонка 5, тип 7,
   функція 8. Для типів це вже лікує фаза типів П3-2b-0 (`typePhase`), для
   згенерованих колонок і функцій — нічого.
5. **Чому сценарій ламається саме на другій зміні.** Перше застосування
   будує ціль тим самим двигуном: `number_period` стає останньою колонкою, і
   копія відтворює ту саму картину. Після `ADD COLUMN note` ціль має
   `…, number_period, note`, а копія будує `CREATE TABLE (…, note)` +
   `ADD COLUMN number_period`. Модель копії з `columnOrder: true` дає
   `tables.app.orders.columns`.

Обмеження, які мусить поважати виправлення (перевірено за фактом):

- **Postgres 17 не перетворює звичайну колонку на згенеровану.**
  `ALTER COLUMN … SET EXPRESSION` замінює вираз лише наявної згенерованої
  колонки, `DROP EXPRESSION` робить зворотне (документація PG 17,
  `sql-altertable`). Шляху «створити звичайну, потім перетворити» немає:
  згенерована колонка з'являється лише в `CREATE TABLE` або
  `ADD COLUMN`, тож порядок дає лише порядок створення.
- **Вираз згенерованої колонки може кликати функцію застосунку**, яку
  двигун створює після таблиці (вага 8 > 5). Без явного ребра колонки з вищим
  `attnum` обійшли б таку колонку навіть без компакції (`compact: false`).
- **Дірки `attnum` після `DROP COLUMN`.** Модель (`mapTable`,
  `pg-delta/map-tables.ts`) сортує колонки за `_position` і зберігає лише
  порядок, а не номер. Копія мусить відтворити відносний порядок уцілілих
  колонок, дірки значення не мають.
- **Ідентичність (`GENERATED … AS IDENTITY`)** входить у речення колонки й
  згортається, як звичайна колонка, — окремого правила не треба.
- **Партиції й успадкування** модель не представляє: `partitionKey`,
  `partitionBound`, `parentTable` дають помилку мапінгу, і план відмовляє
  раніше за копію. Партиційований батько в pg-delta й так вбудовує всі
  колонки в порядку `_position`.
- **Посилання вперед.** `CREATE TABLE` допускає згенеровану колонку, що
  посилається на колонку, оголошену пізніше. Такий порядок відтворює лише
  вбудований `CREATE TABLE`, якого двигун для згенерованої колонки не видає.
  Ланцюг ребер тут дав би цикл, і `topoSort` двигуна кинув би виняток
  («dependency cycle … rule/emission bug»).

## Global Constraints

- 🔴 **Порівняння порядку колонок не послаблювати.** `cloneMismatch`
  (`packages/simetra/src/schema/apply/plan.ts`) і `diffCatalogModels(…,
  { columnOrder: true })` не змінюються: порядок — частина фізичної
  ідентичності (`SELECT *`, `COPY` без переліку колонок).
- 🔴 **Виправлення — в адаптері** (`packages/designer/src/schema-engine/pg-delta/`).
  Пакет pg-delta не патчити (ні `pnpm patch`, ні копія коду). Дія upstream —
  рішення власника, окремо від плану (розділ «Поза планом»).
- 🔴 **Синтетичні ребра — лише в плані копії.** Звичайний план «ціль →
  бажана тінь», `engine.plan` порту й витяги не змінюються.
- 🔴 **Відхилення від спеки чи плану — стоп** і питання архітекторові задачі.
- **Без шимів:** коментарі, що описують старий механізм (фаза типів,
  коментар у `round-trip.db.test.ts` про `plan.clone-mismatch`), переписати
  в тій самій задачі, де змінюється поведінка.
- **DB-тести:** об'єкти стеку — лише через помічники тегу прогону.
  Цілі тестів designer — через `inTarget` з
  `packages/designer/src/__tests__/support/db.ts` (тіні двигуна мають тег із
  setup-файлу DB-проєкту designer); нових ролей і баз поза ними не
  створювати. Імен і даних споживача в тестах немає — лише синтетичні
  об'єкти.
- DB-прогін — лише коли `pgrep -af vitest | grep Simetra` (окремою
  командою) порожній. Без `--` перед шаблоном vitest.
- Коментарі українською й пояснюють «чому». Коміти: Conventional Commits з
  українським описом, без трейлерів.
- Після правок документів — `python3 scripts/check-doc-anchors.py`.

## Review Focus

1. **Згенерована колонка кличе функцію застосунку**
   (`p date GENERATED ALWAYS AS (app.month_of(d)) STORED`, далі `note`).
   Очікування: копія має `…, p, note`, як ціль; `compact: false` цього не
   дав би. Тест — задача 2, «clones a generated column that calls a
   function of the application».
2. **Дірка `attnum` після `DROP COLUMN`** посеред таблиці зі згенерованою
   колонкою. Очікування: відносний порядок уцілілих колонок той самий.
   Тест — задача 2, «clones a generated column in the middle of a table».
3. **Згенерована колонка посилається на пізнішу колонку.** Очікування:
   копія будується без винятку, розбіжність порядку чесно видно в моделі
   (`plan` відмовить `plan.clone-mismatch`), а не падіння двигуна з циклом.
   Тести — задача 1 (ребра не додано) і задача 2 (копія `loaded`).
4. **Колонка типу, створеного в тому самому плані, посеред таблиці**, після
   зняття фази типів. Очікування: порядок копії збігається з ціллю. Тест —
   задача 3, «clones a column of an application type in the middle of a
   table».
5. **Таблиця, яку засіяна копія вже має** (заглушки провайдера). Очікування:
   її колонки ребер не дістають, план копії для неї не змінюється. Тест —
   задача 1, «leaves a table of the source untouched».

## Рішення плану

1. **Порядок колонок копії задають синтетичні ребра в факт-базі цілі.**
   `withColumnOrder(source, target)` повертає копію `target` з ребрами
   `{ from: c[k+1], to: c[k], kind: "depends" }` для колонок кожної таблиці
   (`fact.parent.kind === "table"`), якої немає в `source`, у порядку
   `_position`. Наслідки в двигуні: `topoSort` не випустить створення
   колонки раніше за попередню, а компакція не згорне колонку, чий
   попередник (попередня колонка) лишився окремим `ADD COLUMN`. Колонки до
   першої невбудовної згортаються в `CREATE TABLE`, решта йде `ADD COLUMN`
   рівно в порядку цілі. Ребра — факт фізичної історії таблиці («колонку
   N+1 створено після колонки N»), а не обхід: вони кажуть двигунові те, що
   його власний коментар до `_position` обіцяє («a from-empty CREATE must
   render columns in this order»).
   Вплив на спеку: немає (§6.9 уже вимагає точного відтворення).
2. **Таблиця, що не відтворюється порядком створення, ребер не дістає.**
   Якщо колонка `c[i]` за ребрами цілі (будь-якого виду, транзитивно)
   досягає сусідньої колонки `c[j]` з `j > i`, ланцюг дав би цикл. Тоді вся
   таблиця лишається без ребер, план копії для неї такий, як зараз, і
   розбіжність порядку чесно дає `plan.clone-mismatch`. Відкинуто: ловити
   виняток циклу двигуна (маскує справжні помилки правил) і рвати ланцюг
   лише на одній парі (порядок усе одно не відтворюється).
   Вплив на спеку: немає; рядок у «Відомі обмеження».
3. **Фазу типів П3-2b-0 зняти (підтверджено архітектором задачі).**
   Ланцюг ребер покриває її випадок: колонка типу чекає на `CREATE TYPE`, а
   наступні колонки чекають на неї. Дві механіки одного інваріанту — шим за
   AGENTS.md («when something is replaced, delete the old path»). Зняття —
   окрема задача зі стоп-гейтом за фактом: якщо будь-який тест порядку типів
   без `typePhase` червоний, фазу лишити й звітувати. Разом із фазою
   зникають `CLONE_PHASES` і параметр фази в `reproduce`. Обмеження В-1
   П3-2b-0 («замикання з таблицею») план не оголошує знятим: тесту на нього
   немає.
   Вплив на спеку: немає (рішення 1 П3-2b-0 — рішення плану, не спеки).
4. **Наскрізна перевірка round-trip** (`round-trip.db.test.ts`): для
   кожної фікстури корпусу E1 прийом з нуля проходить `buildPlan` і
   `executePlan(…, { allow: [] })`. Очікування — від втраченої механіки:
   без втрати — `committed`; з утратою — `refused` рівно з
   `apply.permission-required`, чиї пункти — кроки зняття тригерів механіки.
   Ціль у цьому тесті будує SQL рендера Simetra, де `number_period` стоїть
   посередині таблиці, — саме випадок боргу.
   Вплив на спеку: немає.

Відкинуті альтернативи:

- **`compact: false` для плану копії.** Без згортання кожна колонка —
  `ADD COLUMN` у порядку ключа сортування, але колонка, що чекає на функцію
  (вага 8), пропускає вперед готові колонки (вага 5). Гарантії немає.
- **Переписати SQL дій плану** (вбудувати згенеровану колонку, переставити
  `ADD COLUMN`). Хірургія над виводом двигуна, ламка до формату SQL.
- **Перебудувати таблицю копії після відтворення.** Копія порожня, але
  перестворення тягне залежні (FK, індекси, політики, тригери, подання) —
  друга реалізація двигуна.
- **Копія через `pg_dump --schema-only`.** Точний порядок, але зовнішній
  бінарник з прив'язкою до версії сервера, обхід засіву провайдера й межі
  плану, інша модель копії, ніж ухвалена в П3-1.
- **`CREATE DATABASE … TEMPLATE` цілі.** Вимагає відсутності з'єднань до
  цілі й копіює дані.
- **Звичайна колонка, потім перетворення на згенеровану.** У Postgres 17
  такої операції немає (див. «Корінь дефекту»).
- **Патч pg-delta в репо.** Друге джерело коду двигуна з ручним
  оновленням; виправлення upstream — рішення власника.

## Відомі обмеження

- **Колонка, що залежить від пізнішої колонки своєї таблиці** (згенерована
  колонка з посиланням уперед, функція `BEGIN ATOMIC` у виразі, що читає
  пізнішу колонку): копія не відтворює порядку, план відмовляє
  `plan.clone-mismatch`. Відтворити це може лише вбудований `CREATE TABLE`,
  якого двигун для згенерованої колонки не видає. Шлях — upstream.
- **Таблиця, яку засіяна копія вже має**, не впорядковується: це заглушки
  провайдера поза межею плану.

## Поза планом

- **Issue upstream у pg-delta** — зовнішня дія, рішення власника. Суть для
  тексту issue: компакція згортає колонку повз невбудовну колонку з меншим
  `_position`, тож «from-empty CREATE» не дає порядку `_position`, який
  обіцяє коментар витягу; згенерована колонка не згортається ніколи, а
  колонка, що чекає на пізнішу залежність, пропускає вперед готові.
  Відтворення — таблиця `(id int, d date, p date GENERATED ALWAYS AS (d)
  STORED, note text)`, план з порожньої бази. Після виправлення upstream і
  оновлення двигуна контрольний тест задачі 1 («the engine alone …»)
  почервоніє — це сигнал зняти `withColumnOrder`.
- Порядок колонок у звичайному плані «ціль → бажана тінь» не змінюється:
  за спекою §6.9 порядок — не властивість бажаного стану, а
  `apply-lifecycle.db.test.ts` свідомо пінить розбіжність цілі й тіні.

## File Structure

| Файл | Дія | Відповідальність |
| --- | --- | --- |
| `packages/designer/src/schema-engine/pg-delta/column-order.ts` | Create | `withColumnOrder` — ребра порядку колонок нових таблиць |
| `packages/designer/src/schema-engine/__tests__/column-order.test.ts` | Create | Юніт-тести ребер і контрольний план двигуна без бази |
| `packages/designer/src/schema-engine/pg-delta/adapter.ts` | Modify | `cloneAndRun` планує копію над `withColumnOrder`; задача 3 знімає фазу типів |
| `packages/designer/src/schema-engine/pg-delta/type-phase.ts` | Delete (задача 3) | — |
| `packages/designer/src/schema-engine/__tests__/type-phase.test.ts` | Delete (задача 3) | — |
| `packages/designer/src/schema-engine/__tests__/engine-apply-port.db.test.ts` | Modify | Порядок колонок копії на рівні порту |
| `packages/designer/src/__tests__/apply-lifecycle.db.test.ts` | Modify | Сценарій боргу через інструменти `plan`/`apply` |
| `packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts` | Modify | `buildPlan` → `executePlan(allow: [])` на корпусі |
| `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` | Modify | Зняти пункт §1 |
| `docs/ROADMAP.md` | Modify | Посилання на цей план у рядку П3 |

---

### Task 0: Перевірка плану й базова лінія

**Files:** —

- [ ] **Step 1: Якорі плану**

Run: `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-17-clone-column-order.md`
Expected: усі шляхи з File Structure, крім нових, існують; символи
`cloneAndRun`, `withTargetClone`, `typePhase`, `reproduce`, `CLONE_PHASES`,
`cloneMismatch`, `diffCatalogModels`, `expectLossNeedsPermission`,
`deployedRoundTrip` знайдено. Версія pg-delta в `IDENTITY` адаптера —
`1.0.0-alpha.56`; інша версія — стоп: перечитати «Корінь дефекту» на новій
версії й звітувати архітекторові.

- [ ] **Step 2: Базова лінія**

Run: `pnpm --filter @simetra/designer test`, і, коли стек вільний,
`pnpm --filter @simetra/designer test:db engine-apply-port`.
Expected: зелено. Наявні падіння записати в звіт як базові.

### Task 1: `withColumnOrder` — ребра порядку колонок

**Files:**
- Create: `packages/designer/src/schema-engine/pg-delta/column-order.ts`
- Test: `packages/designer/src/schema-engine/__tests__/column-order.test.ts`

**Interfaces:**
- Produces: `withColumnOrder(source: FactBase, target: FactBase): FactBase`
  — нова `FactBase` з усіма фактами й ребрами `target`, тим самим
  `target.source` і тим самим набором reference-only, плюс ребра
  `{ from: c[k+1], to: c[k], kind: "depends" }` (рішення 1, 2). Таблиця —
  факт виду `table`, якого немає в `source`; колонки — її діти виду
  `column`, відсортовані за числом `payload._position`.

- [ ] **Step 1: Юніт-тести (червоні)**

Факти будувати, як у `type-phase.test.ts` (`fact`, `depends`), колонки з
payload `{ type, notNull: false, _position }`, згенерована — ще з
`generatedExpr`. Тести:

- `chains the columns of a new table in attnum order` — колонки `id`(1),
  `d`(2), `p`(3, `generatedExpr`), `note`(4), передані у фактах не за
  порядком; ребро `p → d` уже є в цілі. Новими є рівно `d → id`, `p → d`
  (вже наявне не дублюється), `note → p`; факти й решта ребер — без змін.
- `follows attnum, not names, across dropped-column holes` — позиції 1, 4,
  9 з іменами `z`, `a`, `m` → ребра `a → z`, `m → a`.
- `leaves a table of the source untouched` — та сама таблиця є в `source`
  → жодного нового ребра.
- `adds no edges to a table whose column depends on a later one` — `g`(1)
  з ребром `g → b`, `b`(2) → жодного нового ребра для таблиці.
- `adds no edges when the dependency on a later column is transitive` —
  `c1`(1) → функція `f` → `c3`(3) → жодного нового ребра.
- `keeps the source tag and reference-only facts` — `target`, зібрана з
  `source = "liveDb"` і reference-only фактом; результат має ті самі
  `source` і `isReferenceOnly(id)`.
- Контрольний план двигуна без бази (`plan` з `@supabase/pg-delta`,
  `source` — лише схема `app`, `target` — схема, таблиця `app.t` і колонки з
  першого тесту). Послідовність колонок — `action.produces` виду `column`
  таблиці `app.t` по діях плану (компакція дописує згорнуті колонки в
  `produces` дії `CREATE TABLE` у порядку згортання):
  - `the engine alone puts the generated column last` →
    `["id", "d", "note", "p"]` (документує дефект; почервоніє, коли
    upstream його виправить);
  - `the ordered target keeps attnum order` → `["id", "d", "p", "note"]`.

  Якщо голий `plan` двигуна відмовляє на синтетичних фактах (вимагає
  полів payload, яких тест не дав), додати потрібні поля з помилки; якщо
  він вимагає профілю чи політики — прибрати обидва контрольні тести,
  записати причину у звіт задачі, доказом лишаються DB-тести задачі 2.

Run: `pnpm --filter @simetra/designer test column-order`
Expected: FAIL — модуля `column-order` немає.

- [ ] **Step 2: Реалізувати `withColumnOrder`**

Обхід досяжності — DFS за `target.outgoingEdges(id)` з множиною
відвіданих, для кожної колонки таблиці окремо. Нову `FactBase` збирати, як
`typePhase` (`new FactBase(facts, edges, source, referenceOnly)`); ребро, що
вже є в цілі, не дублювати. Коментар модуля — чому ребра (пункти 2–4
«Кореня дефекту») і чому таблиця з посиланням уперед лишається без них
(рішення 2).

- [ ] **Step 3: Зелено**

Run: `pnpm --filter @simetra/designer test column-order && pnpm --filter @simetra/designer typecheck && pnpm --filter @simetra/designer lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/designer/src/schema-engine/pg-delta/column-order.ts packages/designer/src/schema-engine/__tests__/column-order.test.ts
git commit -m "feat(designer): ребра порядку колонок нових таблиць для плану копії доказу"
```

### Task 2: Копія доказу відтворює порядок колонок цілі

**Files:**
- Modify: `packages/designer/src/schema-engine/pg-delta/adapter.ts` (`cloneAndRun`)
- Test: `packages/designer/src/schema-engine/__tests__/engine-apply-port.db.test.ts`
- Test: `packages/designer/src/__tests__/apply-lifecycle.db.test.ts`

**Interfaces:**
- Consumes: `withColumnOrder` (задача 1).

- [ ] **Step 1: DB-тести порту (червоні)**

У `describe("SchemaEngine apply port")` — помічник
`cloneOrder(targetSql, table)`: `inTarget` → `engine.extract` →
`withTargetClone`, у колбеку — порядок колонок `table` на копії
(`pg_attribute`, `attnum > 0 and not attisdropped order by attnum`, лише
імена) і `engine.extract` копії; повертає порядок цілі, порядок копії,
різницю `diffCatalogModels(target.model, clone.model, { columnOrder: true })`
і помилки `outcome.diagnostics`. Тести:

- `clones a generated column in the middle of a table` — ціль:
  `create schema app; create table app.t (id int primary key, x int, d date not null, p date generated always as (date_trunc('month', d)::date) stored); alter table app.t drop column x; alter table app.t add column note text;`
  → порядок копії `["id", "d", "p", "note"]` дорівнює порядку цілі,
  різниця `[]`, помилок немає.
- `clones a generated column that calls a function of the application` —
  ціль: функція `app.month_of(date) returns date language sql immutable`
  (`select date_trunc('month', $1)::date`), таблиця
  `app.t (id int, d date, p date generated always as (app.month_of(d)) stored, note text)`
  → копія `["id", "d", "p", "note"]`, різниця `[]`.
- `keeps a forward reference loud instead of failing the copy` — ціль:
  `create table app.f (g int generated always as (b * 2) stored, b int)`
  → `outcome.status === "loaded"`, порядок цілі `["g", "b"]`, копії
  `["b", "g"]`, різниця містить шлях `tables.app.f.columns`. Якщо Postgres
  відмовить у такому `CREATE TABLE` — тест прибрати, а рядок у «Відомі
  обмеження» переписати за фактом; звіт архітекторові.

Run: `pgrep -af vitest | grep Simetra` (порожньо), потім
`pnpm --filter @simetra/designer test:db engine-apply-port`
Expected: перші два FAIL (копія `["id", "d", "note", "p"]`), третій PASS.

- [ ] **Step 2: Сценарій боргу через інструменти (червоний)**

У `describe("apply lifecycle")` — тест
`plans again after an attribute is added to a document`. Метадані:
`writeMetadata(dir, party("Party", null), { "documents/Orders/Orders.meta.json": … })`,
документ — `document("Orders", { id: uuid(9240), attributes })` з
`simetra/test/support`, реквізити `amount`
(`{ id: uuid(9241), type: "Numeric", precision: 12, scale: 2 }`) і потім
`note` (`{ id: uuid(9242), type: "String", length: 50 }`). Кроки:

1. Документ з `amount` → `committed(dir, url, await planned(dir, url))`.
2. Додати `note` → `committed(…)`; `columnOrder(url, "app.orders")` має
   `number_period` перед `note`, `note` — остання колонка.
3. Додати довідник `catalogs/Vendor/Vendor.meta.json`
   (`catalog("Vendor", { id: uuid(9243) })`) → `planned(dir, url)` без
   помилок (зараз — `plan.clone-mismatch`), `committed(…)`, далі
   `expectUnchanged(dir, url)`.

Run: `pnpm --filter @simetra/designer test:db apply-lifecycle`
Expected: новий тест FAIL на кроці 3 з `plan.clone-mismatch`.

- [ ] **Step 3: Підключити ребра в `cloneAndRun`**

План фази відтворення будувати над
`withColumnOrder(source.factBase, targetCatalog.factBase)` замість
`targetCatalog.factBase`; фазу типів у цій задачі не чіпати. Переписати
коментар над фазою 1 і над планом фази 2: порядок колонок тепер тримають
ребра, фаза типів лишається до задачі 3.

- [ ] **Step 4: Зелено**

Run: `pnpm --filter @simetra/designer test:db engine-apply-port && pnpm --filter @simetra/designer test:db apply-lifecycle && pnpm --filter @simetra/designer test:db build-plan && pnpm --filter @simetra/designer typecheck && pnpm --filter @simetra/designer lint`
Expected: PASS; наявні тести копії й промоції в `build-plan` — без змін.

- [ ] **Step 5: Commit**

```bash
git add packages/designer/src/schema-engine/pg-delta/adapter.ts packages/designer/src/schema-engine/__tests__/engine-apply-port.db.test.ts packages/designer/src/__tests__/apply-lifecycle.db.test.ts
git commit -m "fix(designer): копія доказу відтворює порядок колонок цілі зі згенерованою колонкою"
```

### Task 3: Зняти фазу типів (рішення 3, стоп-гейт за фактом)

**Files:**
- Modify: `packages/designer/src/schema-engine/pg-delta/adapter.ts` (`cloneAndRun`, `reproduce`, `CLONE_PHASES`)
- Delete: `packages/designer/src/schema-engine/pg-delta/type-phase.ts`
- Delete: `packages/designer/src/schema-engine/__tests__/type-phase.test.ts`
- Test: `packages/designer/src/schema-engine/__tests__/engine-apply-port.db.test.ts`

**Interfaces:**
- Produces: `reproduce(clonePool: pg.Pool, plan: Plan): Promise<EngineDiagnostic | undefined>`
  — без параметра фази; текст збою —
  `applying the target state failed: …`.

- [ ] **Step 1: Регресійний тест порядку типів (зелений і до, і після)**

`clones a column of an application type in the middle of a table` — ціль:
`create schema app; create type app.hue as enum ('red', 'green'); create domain app.positive as int check (value > 0); create table app.card (id int, hue app.hue, n app.positive, label text);`
→ копія `["id", "hue", "n", "label"]` дорівнює цілі, різниця `[]`.

Run: `pnpm --filter @simetra/designer test:db engine-apply-port`
Expected: PASS (ще з фазою типів).

- [ ] **Step 2: Зняти фазу**

`cloneAndRun` будує один план «засіяна копія → `withColumnOrder(засіяна,
ціль)`» і застосовує його `reproduce`. Видалити `type-phase.ts`,
`type-phase.test.ts`, `CLONE_PHASES`, імпорт `typePhase`. Тест
`reports a failure of the type phase as engine.clone-failed`
перейменувати на `reports a failed domain of the target as engine.clone-failed`
з очікуванням `params.detail` за `/^applying the target state failed: \`CREATE DOMAIN/i`;
тест `names the reproduction phase when the type phase has passed`
видалити (фаз більше немає, решту покриває
`reports a failed reproduction as engine.clone-failed`).

- [ ] **Step 3: Стоп-гейт**

Run: `pnpm --filter @simetra/designer test:db engine-apply-port && pnpm --filter @simetra/designer test:db apply-lifecycle && pnpm --filter @simetra/designer test:db build-plan`
Expected: PASS, зокрема `applies a table that uses a type created in the
same plan` і тест кроку 1. **Будь-який червоний тест порядку чи копії —
СТОП:** відкотити кроки 2–3 (`git checkout -- packages/designer`), лишити
тест кроку 1, звітувати архітекторові з текстом падіння; фазу типів не
знімати без його рішення.

- [ ] **Step 4: Перевірки й commit**

Run: `pnpm --filter @simetra/designer test && pnpm --filter @simetra/designer typecheck && pnpm --filter @simetra/designer lint && grep -rn "typePhase\|type-phase" packages/designer/src`
Expected: PASS; `grep` порожній.

```bash
git add -A packages/designer/src/schema-engine
git commit -m "refactor(designer): порядок колонок копії тримають ребра, фазу типів знято"
```

### Task 4: Наскрізна перевірка round-trip (рішення 4)

**Files:**
- Modify: `packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts`

**Interfaces:**
- Consumes: `buildPlan(engine, dbs, model, { target }, [])`,
  `executePlan(db, target, artifact, { mode: "apply", planHash, allow, snapshot })`,
  з `simetra/schema`, `canonicalSnapshot(model)` з `simetra/compiler`;
  `createApplyDatabase({ readOnly })` з `..` — `reader` (`readOnly: true`),
  `scratch` і `writer` (`readOnly: false`), як у `build-plan.db.test.ts`.

- [ ] **Step 1: Тест**

У `deployedRoundTrip` додати параметр `endToEnd: boolean`; корпус E1
(`adoption from scratch: …`) передає `true`, референсний домен — `false`.
Коли `true`, усередині колбека `inTarget` після `roundTripOf`:

1. `buildPlan(engine, { reader, scratch }, result.model, { target }, [])` →
   `status === "planned"`, помилок діагностик немає.
2. `artifact.requiredPermissions` дорівнює ідентифікаторам кроків, які
   `expectLossNeedsPermission` рахує для втрати (порожньо без утрати).
3. `executePlan(writer, target, artifact, { mode: "apply", planHash: artifact.planHash, allow: [], snapshot: canonicalSnapshot(result.model) })`:
   без утрати — `committed`; з утратою — `refused` з діагностиками рівно
   `[apply.permission-required]` і `params.items`, що перелічує ці кроки.

Переписати коментар над `expectLossNeedsPermission`: згадку, що повний
`buildPlan` не проходить доказу через `plan.clone-mismatch`, прибрати;
чисті функції лишаються як точна звірка класів кроків.

- [ ] **Step 2: Прогін**

Run: `pnpm --filter @simetra/designer test:db round-trip`
Expected: PASS. **Відмова `buildPlan` з іншим кодом** (не пов'язаним із
порядком колонок) чи пункти дозволу понад кроки втрати — стоп: не
розширювати очікування, звітувати архітекторові з кодом і фікстурою; тоді
рішення 4 переглядає архітектор.

- [ ] **Step 3: Commit**

```bash
git add packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts
git commit -m "test(designer): round-trip прийому з нуля проходить buildPlan і executePlan без дозволів"
```

### Task 5: Закриття, документи й повні гейти

**Files:**
- Modify: `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md`
- Modify: `docs/ROADMAP.md`
- Modify: цей план (позначки виконання)

- [ ] **Step 1: Документи**

Зняти з боргу §1 пункт «Копія доказу ставить згенеровану колонку в кінець
таблиці» повністю (правило файлу: пункт знімається, коли його бере план).
У рядку П3 `docs/ROADMAP.md` додати посилання
`[план порядку колонок копії](superpowers/plans/2026-10-17-clone-column-order.md)`
поруч з іншими планами П3. Відмітити кроки цього плану.

Run: `python3 scripts/check-doc-anchors.py`
Expected: без мертвих посилань.

- [ ] **Step 2: Повні гейти на одному SHA**

Закомітити крок 1, потім:
`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm metadata:check`,
`python3 scripts/check-doc-anchors.py` і, коли
`pgrep -af vitest | grep Simetra` порожній, `pnpm test:db` — усі на одному
SHA, без правок дерева під час прогону.
Expected: зелено; базові падіння з Task 0 — не нові.

```bash
git add docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md docs/ROADMAP.md docs/superpowers/plans/2026-10-17-clone-column-order.md
git commit -m "docs(plan): порядок колонок копії доказу виконано — пункт боргу П3-2b знято"
```

- [ ] **Step 3: Звіт архітекторові**

SHA задач, результат стоп-гейта задачі 3 (фазу знято чи лишено),
результат задачі 4 по фікстурах корпусу, доля контрольних тестів задачі 1.

## Критерії прийняття

- Сценарій боргу (документ → новий реквізит → будь-яка зміна) планується й
  застосовується без `plan.clone-mismatch` — тест задачі 2.
- Копія відтворює порядок цілі для згенерованої колонки посередині, з
  функцією застосунку у виразі й після `DROP COLUMN` — тести порту.
- Колонка з посиланням уперед не валить копію винятком і чесно дає
  розбіжність порядку.
- Порівняння порядку колонок (`cloneMismatch`, `columnOrder: true`) не
  змінено; pg-delta не пропатчено; звичайний план не змінено.
- Фазу типів знято (або лишено за стоп-гейтом з рішенням архітектора), без
  мертвого коду й коментарів про неї.
- Round-trip корпусу E1 проходить `buildPlan` → `executePlan(allow: [])` з
  очікуванням від утраченої механіки.
- Пункт боргу §1 знято в закривальному коміті; ROADMAP посилається на план.
- Гейти: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, повний
  `pnpm test:db` — зелені на одному SHA.
