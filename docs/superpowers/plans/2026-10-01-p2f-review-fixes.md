# П2, план F — виправлення за рев'ю C3 і D1: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** закрити підтверджені дефекти рев'ю C3/D1 і прогалини, які
заважатимуть E1 (рендер і розгортання в Postgres), D2 (каскад перейменування)
і E2 (round-trip реальних таблиць): індекс посилань на колонки `CustomTable`,
конфлікти імен у просторах Postgres, предвизначені елементи з фізичною
міткою, повнота опису `CustomTable`, перевірки значень і тексти спек.

**Архітектура:** правки в межах наявних ярусів T0/T1 без нових залежностей;
кожна задача — власний тест-цикл і коміт. Модельні рішення вже ухвалені
власником (нижче); задача 0 вносить їх у спеки першою, щоб код ішов за
спекою.

**Технології:** TypeScript 7, Zod 4, Vitest 5, libpg-query 17.7.4.

**Спеки:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md),
[«Платформа в Postgres»](../specs/2026-10-01-platform-in-postgres-design.md),
[платформна спека](../specs/2026-09-24-simetra-platform-design.md).

**Порядок робіт П2 (власник, 2026-10-01):** F (цей) → E1 (рендер DDL у T2,
синтетичний домен, розгортання в локальний стек, паперовий тест) → D2 (CLI,
MCP, pre-commit) → E2 (pg-delta, зворотна генерація, round-trip, приватна
звірка).

## Рішення плану

1. **Предвизначені елементи (власник; виміряно на живій 1С 8.3.27):** рядок
   предвизначеного має **власний** `id` у кожній базі й кожному скоупі.
   Ознака — колонка `predefined_name text` з **фізичною міткою** елемента:
   `predefinedItems[].physicalName`, яку `simetra fix` призначає раз
   (snake_case початкового імені) і яка не змінюється при перейменуванні,
   — той самий шаблон, що мітка значення перерахування (М15). Частковий
   **унікальний** індекс `(носій скоупу, predefined_name) WHERE predefined_name IS NOT NULL`
   (1С унікальності не тримає — джерело її дублів). Засів (П3):
   `INSERT … ON CONFLICT (носій, predefined_name) DO NOTHING` з
   `gen_random_uuid()` — реквізити рядка належать користувачу; новий скоуп
   засівається тригером на корені; елемент, прибраний з метаданих, не
   видаляє рядка — звуження очищає ознаку; фізичне видалення рядка з ознакою
   заборонене (П3), позначка видалення — дозволена. Пошук — згенерована
   `STABLE` функція `<catalog>_predefined(p_scope uuid, p_label text) RETURNS uuid`
   (у глобального довідника — без `p_scope`).
2. **Перерахування** лишаються мітками + `CHECK` (М15): у 1С ідентичність
   значення — метадані (посилання однакове в усіх базах, виміряно), значень
   без реквізитів засівати не треба.
3. **Простір імен Postgres** — один механізм перевірки конфліктів для
   SQL-одиниць, таблиць і енам-типів моделі та обгорток рухів (`pg_proc`,
   `pg_class`, `pg_type`); `sql.unit-duplicate` лишається для тотожної
   ідентичності, новий `sql.namespace-conflict` — для різних класів в одному
   просторі.
4. **Посилання на колонки `CustomTable`** — у індексі посилань стадії 2;
   стадії 3–4 читають індекс, а не резолвлять імена вдруге.

## Global Constraints

- Чистота ярусів: T0 — лише `zod`; T1 — без Node API. Без нових залежностей.
- Детермінізм знімка, порядку й хешу; без шимів (`git rm`, без аліасів).
- Тексти діагностики — en і uk; коментарі — українською.
- Коміти — Conventional Commits, опис українською, без трейлерів; явні шляхи.
- Гейти після кожної задачі: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  після правки доків — `python3 scripts/check-doc-anchors.py`.

## Review Focus

1. **Перейменування реквізиту довідника, на який посилається FK
   `CustomTable`** — посилання є в індексі, канонічний фрагмент `CustomTable`
   не змінюється. Тест — задача 1.
2. **Таблиця моделі й `CREATE VIEW`/`SEQUENCE`/`DOMAIN` з тим самим іменем,
   функція й процедура з однаковою сигнатурою** — діагностика компілятора,
   а не `ok: true`. Тест — задача 2.
3. **Скоуплений довідник із предвизначеними** — ключ засіву (скоуп, мітка),
   перейменування елемента не змінює мітки. Тест — задача 3.
4. **Реальна таблиця споживача з `DESC`-індексом, opclass, генерованою
   колонкою чи `DEFERRABLE UNIQUE`** — виражається `CustomTable`, а не
   губиться. Тест — задача 4.
5. **Хибний часовий пояс проєкту чи типове значення поза типом** — помилка
   компілятора, а не падіння DDL у П3. Тест — задача 5.

---

### Task 0: Тексти спек

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md`, `docs/superpowers/specs/2026-10-01-platform-in-postgres-design.md`, `docs/superpowers/specs/2026-09-24-simetra-platform-design.md`, `docs/research/1c-model/platform-in-practice-2026-10.md`

- [ ] **Step 1:** Спека П2:
  - рядок М21 — замість формули `date_trunc(<періодичність>, date, '<пояс>')`
    посилання «генерована колонка періоду в поясі проєкту (§5)» (формула
    живе в одному місці);
  - М18 і §5 (стандартні реквізити довідника) — предвизначені за «Рішенням
    плану» п. 1: власний `id` рядка, `predefined_name` = фізична мітка
    елемента, частковий унікальний індекс, засів `ON CONFLICT … DO NOTHING`,
    функція пошуку; у §3 «Фізичні імена» — мітка предвизначеного поруч із
    міткою значення перерахування;
  - §8.3 — правило кваліфікації типів аргументів в ідентичності SQL-одиниць,
    як його реалізовано (`_x → x[]` лише для `pg_catalog`; тип, відомий
    моделі, — її схемою; типи рядків таблиць моделі відомі; невідомий — як
    є) і простори імен Postgres «Рішення плану» п. 3;
  - §4 — повнота `CustomTable` задачі 4 (генерована колонка, колляція,
    порядок/nulls/opclass/колляція ключа індексу, `deferrable` PK і UNIQUE);
  - §14 — прибрати закриті рядки (DSL в AST, імена в конструкторі); додати
    борги: псевдотипи (`anyelement`, `anyarray`) у сигнатурах, `COMMENT ON FUNCTION`
    без аргументів як друга ідентичність того самого об'єкта.
- [ ] **Step 2:** «Платформа в Postgres»: §6 `balance` — з реєстратором
  `(period, recorder_type, recorder_id) < (p_at, …)` (строго, як у Р26 і П2
  §7); §4 `predefined_name` і Р24 — за «Рішенням плану» п. 1 (замість «MERGE за
  `id`»). Платформна спека §4 і Р24 — те саме формулювання засіву.
- [ ] **Step 3:** `platform-in-practice-2026-10.md` §2 — у `_PredefinedID`
  зберігається ідентифікатор предвизначеного елемента з метаданих, а не ім'я;
  посилання предвизначеного в кожній базі своє, посилання значення
  перерахування однакове в усіх базах (виміряно на 8.3.27).
- [ ] **Step 4:** `python3 scripts/check-doc-anchors.py` — чисто.
- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs docs/research/1c-model/platform-in-practice-2026-10.md
git commit -m "docs(spec): виправлення за рев'ю C3/D1 — предвизначені з міткою, межа balance, період номера, простори імен, повнота CustomTable"
```

---

### Task 1: Посилання на колонки `CustomTable` в індексі посилань

**Files:**
- Modify: `packages/simetra/src/model/kinds/custom-table.ts` (`references`), `model/kinds/standard.ts` (`ReferenceRole`), `compiler/stages/identity.ts`, `compiler/stages/model.ts` (`declaredColumnMap`, `logicalColumnsOf`), `compiler/stages/integrity.ts` (`checkDeclaredTable`, `columnsExist`), `compiler/canonical.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/custom-table-references.test.ts`

**Interfaces:**
- Produces:
  - Ролі `customTable.column` (власна колонка таблиці: `primaryKey.columns[i]`,
    `uniques[j].columns[i]`, `foreignKeys[j].columns[i]`, `indexes[j].keys[i].column`,
    `indexes[j].include[i]`) і `customTable.foreignKeyTarget` (колонка цілі
    внутрішнього FK: `foreignKeys[j].references.columns[i]`; для цілі виду 1С
    — стандартний реквізит як синтетичний `Element`-id `<objectId>#<canonical>`,
    як у виразах конструктора); `to.kind: "Element"`.
  - `customTable.column-unknown` переїжджає в стадію 2 (той самий код і
    pointer); стадії 3 і 4 беруть фізичне ім'я за id з індексу — резолв за
    іменем (`?? n`-фолбек і `columnsExist`) видаляється.
  - `canonicalData` пише id для цих pointer-ів (як для інших посилань).

- [ ] **Step 1: Тести** — `custom table column lists are indexed` (усі шість
  позицій, ролі й pointer-и); `foreign key target columns of another object
  are indexed` (ціль — довідник, колонка `sku` → id реквізиту; ціль —
  стандартний `ref` → синтетичний id); `unknown column is reported by stage 2`;
  `renaming a catalog attribute keeps the custom table canonical fragment`;
  `every element-name field of CustomTable yields index entries` (обхід схеми:
  кожне поле `elementNameSchema` у `customTableSchema`, крім імен самих
  колонок, дає запис індексу для заповненої фікстури).
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test custom-table-references` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "fix(compiler): посилання на колонки CustomTable в індексі посилань стадії 2"
```

---

### Task 2: Конфлікти імен у просторах Postgres

**Files:**
- Modify: `packages/simetra/src/compiler/sql/units.ts`, `compiler/stages/integrity.ts` (`functionCollisions`), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/sql-namespaces.test.ts`

**Interfaces:**
- Produces:
  - `pgNamespaceKey(unit | table | enumType): { space: "proc" | "rel" | "type"; key: string }[]`
    — `proc`: `schema.name(канонічні типи аргументів)` для function,
    procedure, aggregate, movementQuery; `rel`: `schema.name` для таблиць
    знімка, view, materializedView, sequence; `type`: `schema.name` для
    енам-типів, доменів і складених типів таблиць та в'юх (таблиця й
    в'юха займають і `rel`, і `type`).
  - Одна перевірка над усіма вузлами: два різні вузли з тим самим ключем —
    `sql.namespace-conflict` (`params.space`, `params.key`, `params.other` —
    ідентичність чи таблиця, з якою конфлікт); тотожна ідентичність
    лишається `sql.unit-duplicate`. Пропуск обгорток рухів у
    `functionCollisions` прибирається — їх покриває ця перевірка;
    `physical.function-duplicate` лишається для функцій контрактів.
  - Джерело класових множин — наявні `FUNCTION_CLASSES` і реєстрація вузлів
    у `sql/dependencies.ts` (одне місце).

- [ ] **Step 1: Тести** — по тесту на кожну пару з рев'ю: `function and
  procedure with the same signature`; `procedure with the movement wrapper
  signature`; `aggregate and function`; `model table and view / sequence /
  domain with the same name`; `view and materialized view`; контроль: функції
  з різними сигнатурами — чисто; однакове ім'я в різних схемах — чисто.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test sql-namespaces` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "fix(compiler): конфлікти імен у просторах pg_proc, pg_class і pg_type"
```

---

### Task 3: Предвизначені елементи з фізичною міткою

**Files:**
- Modify: `packages/simetra/src/model/schemas/catalog.ts` (`predefinedItems`), `model/kinds/catalog.ts`, `compiler/stages/identity.ts` (`namedElementFields`: `physical: true`), `compiler/contracts.ts`, `compiler/codegen.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/predefined.test.ts`; оновити тести C3/D1 з предвизначеними

**Interfaces:**
- Produces:
  - `predefinedItems[]: { id?, name: objectNameSchema, physicalName?: physicalNameSchema, description? }`
    — `physicalName` (мітка) обов'язкова на стадії 2
    (`identity.physical-name-missing`, hint `simetra fix`), унікальна в межах
    довідника (`identity.name-duplicate` для імен і для міток).
  - Стандартна колонка `predefinedName ↔ predefined_name text` (значення —
    мітка); частковий унікальний індекс `(носій скоупу, predefined_name) WHERE predefined_name IS NOT NULL`
    (у глобального — без носія) — як зараз, змінюється лише зміст колонки.
  - `PredefinedContract { objectId: string; column: "predefined_name"; scopeColumn?: string; lookupFunction: { schema: string; name: string }; items: { id: string; name: string; label: string }[] }`
    — `lookupFunction` = `makeObjectName(<table>, undefined, "predefined")`
    у схемі довідника; колізія — наявна `physical.function-duplicate`.
  - Кодоген: для довідника з предвизначеними — union логічних імен і мапа
    «логічне ім'я → мітка» (як для перерахувань).

- [ ] **Step 1: Тести** — `predefined item needs a label`; `labels are unique
  within a catalog`; `contract carries labels, scope column and lookup
  function`; `renaming a predefined item keeps its label and the physical
  snapshot`; `scoped catalog index starts with the scope carrier`;
  `lookup function name collides with a table → physical.function-duplicate`.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test predefined` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти; JSON Schema оновлено
  (`UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`).
- [ ] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(model): предвизначені елементи з фізичною міткою й функцією пошуку в контракті"
```

---

### Task 4: Повнота опису `CustomTable` для round-trip

**Files:**
- Modify: `packages/simetra/src/model/schemas/custom-table.ts`, `model/physical/snapshot.ts`, `compiler/stages/model.ts`, `compiler/stages/integrity.ts`, `compiler/sql/dependencies.ts` (ребра генерованих колонок і ключів-виразів уже є — перевірити для нових полів), `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/custom-table-physics.test.ts`

**Interfaces:**
- Produces:
  - Колонка: `generated?: { expression: string }` (`GENERATED ALWAYS AS (...) STORED`;
    несумісне з `default` та `identity` — `customTable.generated-conflict`),
    `collation?: string`.
  - Ключ індексу: `{ column | expression, order?: "asc" | "desc", nulls?: "first" | "last", opclass?: string, collation?: string }`.
  - PK і UNIQUE: `deferrable: "no" | "deferrable" | "initiallyDeferred" = "no"`
    (як у FK).
  - Знімок: `PhysicalColumn.collation?`; ключ індексу з тими самими
    полями; `deferrable` у `primaryKey` і `uniques`. Похідні види 1С —
    значення за замовчуванням (без змін виходу).

- [ ] **Step 1: Тести** — `generated column reaches the snapshot`;
  `generated with default is an error`; `desc nulls last opclass index key`;
  `deferrable unique and primary key`; `column collation`; `1C kinds
  snapshot unchanged` (знімок фікстури C3 побайтно той самий, крім нових
  необов'язкових полів).
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test custom-table-physics` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти; JSON Schema оновлено.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(model): CustomTable — генеровані колонки, колляції, порядок і opclass ключа індексу, deferrable ключів"
```

---

### Task 5: Перевірки значень, гейт блоку рухів, хвости тестів

**Files:**
- Modify: `packages/simetra/src/compiler/stages/integrity.ts` або `stages/links.ts` (за місцем наявних перевірок), `compiler/sql/units.ts` чи `stages/links.ts` (гейт блоку), `compiler/sql/dependencies.ts` (CTE), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/value-checks.test.ts`, `creation-order.test.ts`, `canonical.test.ts`, `stage-links.test.ts`, `json-schema.test.ts`

**Interfaces:**
- Produces:
  - `project.timezone-unknown` — пояс не в `Intl.supportedValuesOf("timeZone")`
    і не `UTC` (ECMAScript, не Node API; pointer `/timezone`).
  - `type.default-invalid` — `defaultValue` поза типом: `Date` — `YYYY-MM-DD`;
    `DateTime` — ISO 8601 з поясом; `String` — довжина ≤ `length`;
    `Numeric` — у межах `precision`/`scale`; `Integer`/`SmallInt` — ціле в
    діапазоні; `BigInt` — ціле число в межах `Number.MAX_SAFE_INTEGER` або
    рядок цілого числа в межах int8; `Boolean` — `true`/`false`.
  - Гейт блоку рухів: CTE, що змінює дані (`INSERT`/`UPDATE`/`DELETE` у
    `WITH`), і `FOR UPDATE`/`FOR SHARE` — `posting.query-not-select`.
  - `sql/dependencies.ts`: CTE `t` виключається лише з посилань **після**
    свого визначення; посилання на `t` усередині тіла самого CTE
    (`WITH t AS (SELECT * FROM t)`) — ребро на справжню таблицю `t`.

- [ ] **Step 1: Тести**
  - `unknown timezone`, `UTC and Europe/Kyiv are accepted`;
  - `default value checks` — по кейсу на тип;
  - `data-modifying CTE and FOR UPDATE in movement block are rejected`;
  - `cte shadowing keeps the edge to the real table`;
  - `domain column alone orders the domain first` (таблиця без інших
    залежностей, колонка `Raw pgType: z.code` → `["domain:z.code", "table:…"]`;
    без ребра таблиця пішла б першою) і `composite type column` (`CREATE TYPE z.pair AS (a int, b int)`);
  - `aggregates in constructor are canonical by id` (`sum`/`count` — у
    канонічному знімку id ТЧ і реквізиту, перейменування ТЧ хеш
    документа-посилача не змінює);
  - `orphan json schema file fails the drift test` (файл у `schemas/`, якого
    генератор не дає).
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test value-checks creation-order canonical stage-links json-schema` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Канон і статус** — `simetra-domain-criteria.md`: критерій
  SQL-одиниць доповнити просторами імен Postgres; критерій `CustomTable` —
  колонки в індексі посилань. `docs/ROADMAP.md`: посилання на план, «Зараз» —
  F виконано, далі E1. `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 6: Commit**

```bash
git add packages/simetra .agents docs/ROADMAP.md
git commit -m "fix(compiler): перевірки поясу й типових значень, гейт блоку рухів, ребро крізь CTE, хвости тестів"
```

---

## Критерії приймання плану F

- Перейменування будь-якого елемента, на який посилаються колонки
  `CustomTable`, видно в індексі посилань; канонічний фрагмент таблиці не
  змінюється.
- Конфлікти в `pg_proc`/`pg_class`/`pg_type` — діагностика компілятора.
- Предвизначені мають мітку, унікальну в межах довідника; контракт дає ключ
  засіву (скоуп, мітка) і функцію пошуку.
- `CustomTable` описує генеровані колонки, колляції, порядок/opclass ключів
  індексу і `deferrable` ключів.
- Спеки узгоджені між собою (М21, межа `balance`, предвизначені).
- Гейти зелені; гард якорів чистий.
